const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const pdf = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// =========================================================
// TEMPORARY PDF MEMORY
// =========================================================

let lastPdfText = "";
let publishedQuizzes = {};

// =========================================================
// MULTER
// =========================================================

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

// =========================================================
// GEMINI
// =========================================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =========================================================
// HOME
// =========================================================

app.get("/", (req, res) => {
  res.send("Advance's Quiz Backend Running!");
});

// =========================================================
// GENERATE QUIZ
// =========================================================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  let filePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a PDF file.",
      });
    }

    filePath = req.file.path;

    const numberOfQuestions = Number(req.body.numberOfQuestions) || 5;

    const marksPerQuestion = Number(req.body.marksPerQuestion) || 1;

    const difficulty = req.body.difficulty || "moderate";

    console.log("PDF received:", req.file.originalname);

    console.log("Difficulty:", difficulty);

    // =====================================================
    // 1. EXTRACT PDF TEXT
    // =====================================================

    const dataBuffer = fs.readFileSync(filePath);

    const pdfData = await pdf(dataBuffer);

    const extractedText = pdfData.text.trim();

    if (!extractedText) {
      throw new Error(
        "Could not extract text from this PDF. It may be an image/scanned PDF.",
      );
    }

    console.log("Extracted characters:", extractedText.length);

    // =====================================================
    // SAVE PDF TEXT FOR REGENERATION
    // =====================================================

    lastPdfText = extractedText.slice(0, 60000);

    console.log("PDF context saved for regeneration.");

    // =====================================================
    // 2. GEMINI
    // =====================================================

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // =====================================================
    // 3. PROMPT
    // =====================================================

    const prompt = `
You are an expert college examination question generator.

Create exactly ${numberOfQuestions} multiple-choice questions from the provided study material.

DIFFICULTY:
${difficulty}

Difficulty rules:

EASY:
- Basic concepts
- Direct recall
- Simple understanding

MODERATE:
- Conceptual understanding
- Application of concepts
- Some reasoning required

HARD:
- Deep conceptual understanding
- Analysis
- Application
- Challenging but fair

Each question must:

1. Be based ONLY on the provided PDF content.
2. Be appropriate for college students.
3. Have exactly 4 options.
4. Have exactly ONE correct answer.
5. Avoid duplicate questions.
6. Avoid ambiguous questions.
7. Avoid questions where multiple options could reasonably be correct.
8. Make incorrect options plausible.
9. Do not invent facts that are not supported by the PDF.
10. Return ONLY valid JSON.

Marks per question:
${marksPerQuestion}

Return this exact JSON structure:

{
  "questions": [
    {
      "question": "Question text",
      "options": [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      "correctAnswer": 0,
      "explanation": "Short explanation of why the answer is correct"
    }
  ]
}

IMPORTANT:

- correctAnswer must be 0, 1, 2, or 3.
- 0 means Option A.
- 1 means Option B.
- 2 means Option C.
- 3 means Option D.
- Do not include markdown.
- Do not include code fences.
- Return JSON only.

STUDY MATERIAL:

${lastPdfText}
`;

    console.log("Generating questions with Gemini...");

    const result = await model.generateContent(prompt);

    const responseText = result.response.text().trim();

    console.log("Gemini response received.");

    // =====================================================
    // 4. CLEAN RESPONSE
    // =====================================================

    let cleanedResponse = responseText;

    if (cleanedResponse.startsWith("```json")) {
      cleanedResponse = cleanedResponse
        .replace(/^```json/, "")
        .replace(/```$/, "")
        .trim();
    }

    if (cleanedResponse.startsWith("```")) {
      cleanedResponse = cleanedResponse
        .replace(/^```/, "")
        .replace(/```$/, "")
        .trim();
    }

    // =====================================================
    // 5. PARSE JSON
    // =====================================================

    let quizData;

    try {
      quizData = JSON.parse(cleanedResponse);
    } catch (jsonError) {
      console.error("Invalid Gemini JSON:");

      console.error(responseText);

      throw new Error("AI returned an invalid quiz format. Please try again.");
    }

    if (!quizData.questions || !Array.isArray(quizData.questions)) {
      throw new Error("AI did not return a valid question list.");
    }

    // =====================================================
    // 6. VALIDATE
    // =====================================================

    const validQuestions = quizData.questions
      .slice(0, numberOfQuestions)
      .filter((q) => {
        return (
          q.question &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          Number.isInteger(q.correctAnswer) &&
          q.correctAnswer >= 0 &&
          q.correctAnswer <= 3
        );
      })
      .map((q) => ({
        question: q.question,

        options: q.options,

        correctAnswer: q.correctAnswer,

        explanation: q.explanation || "",

        marks: marksPerQuestion,

        difficulty,
      }));

    if (validQuestions.length === 0) {
      throw new Error("No valid questions were generated.");
    }

    // =====================================================
    // 7. RESPONSE
    // =====================================================

    res.json({
      success: true,

      totalQuestions: validQuestions.length,

      marksPerQuestion,

      totalMarks: validQuestions.length * marksPerQuestion,

      difficulty,

      questions: validQuestions,
    });
  } catch (error) {
    console.error("GENERATE QUIZ ERROR:");

    console.error(error);

    res.status(500).json({
      error: error.message || "Something went wrong while generating the quiz.",
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

// =========================================================
// REGENERATE ONE QUESTION
// =========================================================

app.post("/regenerate-question", async (req, res) => {
  try {
    // -----------------------------------------------------
    // CHECK PDF CONTEXT
    // -----------------------------------------------------

    if (!lastPdfText) {
      return res.status(400).json({
        error: "PDF context not found. Please generate the quiz again.",
      });
    }

    const { difficulty, previousQuestion } = req.body;

    const selectedDifficulty = difficulty || "moderate";

    // -----------------------------------------------------
    // GEMINI
    // -----------------------------------------------------

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // -----------------------------------------------------
    // PROMPT
    // -----------------------------------------------------

    const prompt = `
You are an expert college examination question generator.

Generate EXACTLY ONE new multiple-choice question.

The question MUST be based ONLY on the provided PDF study material.

DIFFICULTY:
${selectedDifficulty}

Difficulty rules:

EASY:
- Basic concepts
- Direct recall
- Simple understanding

MODERATE:
- Conceptual understanding
- Application
- Some reasoning

HARD:
- Deep conceptual understanding
- Analysis
- Application
- Challenging but fair

IMPORTANT:

1. Generate exactly ONE question.
2. Generate exactly FOUR options.
3. Only ONE option can be correct.
4. The question must be based ONLY on the PDF.
5. Do NOT repeat the previous question.
6. Do NOT create a minor rewording of the previous question.
7. Make incorrect options plausible.
8. Avoid ambiguous questions.
9. Do not invent information.
10. Return ONLY valid JSON.
11. Do not include markdown.
12. Do not include code fences.

PREVIOUS QUESTION:

${previousQuestion || "None"}

Return EXACTLY this structure:

{
  "question": "Question text",
  "options": [
    "Option A",
    "Option B",
    "Option C",
    "Option D"
  ],
  "correctAnswer": 0,
  "explanation": "Short explanation"
}

correctAnswer rules:

0 = Option A
1 = Option B
2 = Option C
3 = Option D

PDF STUDY MATERIAL:

${lastPdfText}
`;

    console.log("Regenerating question...");

    console.log("Difficulty:", selectedDifficulty);

    const result = await model.generateContent(prompt);

    const responseText = result.response.text().trim();

    console.log("Gemini regeneration response received.");

    // -----------------------------------------------------
    // CLEAN RESPONSE
    // -----------------------------------------------------

    let cleanedResponse = responseText;

    if (cleanedResponse.startsWith("```json")) {
      cleanedResponse = cleanedResponse
        .replace(/^```json/, "")
        .replace(/```$/, "")
        .trim();
    }

    if (cleanedResponse.startsWith("```")) {
      cleanedResponse = cleanedResponse
        .replace(/^```/, "")
        .replace(/```$/, "")
        .trim();
    }

    // -----------------------------------------------------
    // PARSE
    // -----------------------------------------------------

    let newQuestion;

    try {
      newQuestion = JSON.parse(cleanedResponse);
    } catch (jsonError) {
      console.error("Invalid regeneration JSON:");

      console.error(responseText);

      throw new Error("AI returned an invalid question format.");
    }

    // -----------------------------------------------------
    // VALIDATE
    // -----------------------------------------------------

    if (
      !newQuestion.question ||
      !Array.isArray(newQuestion.options) ||
      newQuestion.options.length !== 4 ||
      !Number.isInteger(newQuestion.correctAnswer) ||
      newQuestion.correctAnswer < 0 ||
      newQuestion.correctAnswer > 3
    ) {
      throw new Error("AI returned an invalid question.");
    }

    // -----------------------------------------------------
    // SEND NEW QUESTION
    // -----------------------------------------------------

    res.json({
      success: true,

      question: {
        question: newQuestion.question,

        options: newQuestion.options,

        correctAnswer: newQuestion.correctAnswer,

        explanation: newQuestion.explanation || "",

        difficulty: selectedDifficulty,
      },
    });
  } catch (error) {
    console.error("REGENERATE QUESTION ERROR:");

    console.error(error);

    res.status(500).json({
      error: error.message || "Failed to regenerate question.",
    });
  }
});

// =========================================================
// PUBLISH QUIZ
// =========================================================

app.post("/publish-quiz", (req, res) => {
  try {
    const { quiz } = req.body;

    if (!quiz || !quiz.questions) {
      return res.status(400).json({
        error: "Invalid quiz data.",
      });
    }

    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "STX";

    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    publishedQuizzes[code] = {
      ...quiz,

      code,

      status: "live",

      createdAt: new Date().toISOString(),
    };

    console.log("Quiz published:", code);

    res.json({
      success: true,
      code,
    });
  } catch (error) {
    console.error("PUBLISH QUIZ ERROR:", error);

    res.status(500).json({
      error: "Failed to publish quiz.",
    });
  }
});

// =========================================================
// GET QUIZ BY CODE
// =========================================================

app.get("/quiz/:code", (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const quiz = publishedQuizzes[code];

    if (!quiz) {
      return res.status(404).json({
        error: "Quiz not found or no longer available.",
      });
    }

    res.json({
      success: true,
      quiz,
    });
  } catch (error) {
    console.error("GET QUIZ ERROR:", error);

    res.status(500).json({
      error: "Failed to load quiz.",
    });
  }
});

// =========================================================
// SERVER
// =========================================================

const PORT = 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

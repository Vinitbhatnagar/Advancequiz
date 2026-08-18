const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const pdf = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

require("dotenv").config();

// =========================================================
// FIREBASE
// =========================================================

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

// =========================================================
// EXPRESS
// =========================================================

const app = express();

app.use(cors());
app.use(express.json());

// =========================================================
// TEMPORARY PDF MEMORY
// =========================================================

let lastPdfText = "";

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
    // -----------------------------------------------------
    // CHECK PDF
    // -----------------------------------------------------

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a PDF file.",
      });
    }

    filePath = req.file.path;

    // -----------------------------------------------------
    // SETTINGS
    // -----------------------------------------------------

    const numberOfQuestions = Number(req.body.numberOfQuestions) || 5;

    const marksPerQuestion = Number(req.body.marksPerQuestion) || 1;

    const difficulty = req.body.difficulty || "moderate";

    // Timer in minutes
    const timeLimit = Number(req.body.timeLimit) || 30;

    console.log("PDF received:", req.file.originalname);

    console.log("Number of questions:", numberOfQuestions);

    console.log("Marks per question:", marksPerQuestion);

    console.log("Difficulty:", difficulty);

    console.log("Time limit:", timeLimit, "minutes");

    // =====================================================
    // EXTRACT PDF TEXT
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
    // SAVE PDF CONTEXT
    // =====================================================

    lastPdfText = extractedText.slice(0, 60000);

    console.log("PDF context saved for regeneration.");

    // =====================================================
    // GEMINI MODEL
    // =====================================================

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // =====================================================
    // PROMPT
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
    // CLEAN GEMINI RESPONSE
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
    // PARSE JSON
    // =====================================================

    let quizData;

    try {
      quizData = JSON.parse(cleanedResponse);
    } catch (jsonError) {
      console.error("Invalid Gemini JSON:");

      console.error(responseText);

      throw new Error("AI returned an invalid quiz format. Please try again.");
    }

    // =====================================================
    // VALIDATE QUESTIONS ARRAY
    // =====================================================

    if (!quizData.questions || !Array.isArray(quizData.questions)) {
      throw new Error("AI did not return a valid question list.");
    }

    // =====================================================
    // VALIDATE QUESTIONS
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
    // RESPONSE
    // =====================================================

    res.json({
      success: true,

      totalQuestions: validQuestions.length,

      marksPerQuestion,

      totalMarks: validQuestions.length * marksPerQuestion,

      difficulty,

      timeLimit,

      questions: validQuestions,
    });
  } catch (error) {
    console.error("GENERATE QUIZ ERROR:");

    console.error(error);

    res.status(500).json({
      success: false,

      error: error.message || "Something went wrong while generating the quiz.",
    });
  } finally {
    // -----------------------------------------------------
    // DELETE TEMPORARY PDF
    // -----------------------------------------------------

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
    // ---------------------------------------------------
    // CHECK PDF CONTEXT
    // ---------------------------------------------------

    if (!lastPdfText) {
      return res.status(400).json({
        success: false,

        error: "PDF context not found. Please generate the quiz again.",
      });
    }

    const { difficulty, previousQuestion } = req.body;

    const selectedDifficulty = difficulty || "moderate";

    // ---------------------------------------------------
    // GEMINI
    // ---------------------------------------------------

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // ---------------------------------------------------
    // PROMPT
    // ---------------------------------------------------

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

    // ---------------------------------------------------
    // CLEAN RESPONSE
    // ---------------------------------------------------

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

    // ---------------------------------------------------
    // PARSE
    // ---------------------------------------------------

    let newQuestion;

    try {
      newQuestion = JSON.parse(cleanedResponse);
    } catch (jsonError) {
      console.error("Invalid regeneration JSON:");

      console.error(responseText);

      throw new Error("AI returned an invalid question format.");
    }

    // ---------------------------------------------------
    // VALIDATE
    // ---------------------------------------------------

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

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

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
      success: false,

      error: error.message || "Failed to regenerate question.",
    });
  }
});

// =========================================================
// GENERATE UNIQUE QUIZ CODE
// =========================================================

function generateQuizCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "STX";

  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return code;
}

// =========================================================
// PUBLISH QUIZ
// =========================================================

app.post("/publish-quiz", async (req, res) => {
  try {
    const { quiz } = req.body;

    if (!quiz || !quiz.questions || !Array.isArray(quiz.questions)) {
      return res.status(400).json({
        success: false,

        error: "Invalid quiz data.",
      });
    }

    // ---------------------------------------------------
    // GENERATE UNIQUE CODE
    // ---------------------------------------------------

    let code;
    let quizRef;
    let quizSnapshot;

    // Make sure the generated code
    // does not already exist.
    do {
      code = generateQuizCode();

      quizRef = db.collection("quizzes").doc(code);

      quizSnapshot = await quizRef.get();
    } while (quizSnapshot.exists);

    // ---------------------------------------------------
    // TIME LIMIT
    // ---------------------------------------------------

    const timeLimit = Number(quiz.timeLimit) || 30;

    // ---------------------------------------------------
    // QUIZ DATA
    // ---------------------------------------------------

    const quizData = {
      ...quiz,

      code,

      status: "live",

      createdAt: new Date().toISOString(),

      timeLimit,

      totalStudents: 0,
    };

    // ---------------------------------------------------
    // SAVE QUIZ
    // ---------------------------------------------------

    await quizRef.set(quizData);

    console.log("Quiz published to Firestore:", code);

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

    res.json({
      success: true,

      code,

      quiz: quizData,
    });
  } catch (error) {
    console.error("PUBLISH QUIZ ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to publish quiz.",
    });
  }
});

// =========================================================
// GET QUIZ BY CODE
// =========================================================

// =========================================================
// STUDENT JOIN QUIZ + START ATTEMPT
// =========================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const { studentName, enrollment } = req.body;

    // -----------------------------------------------------
    // VALIDATE NAME
    // -----------------------------------------------------

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({
        success: false,
        error: "Student name is required.",
      });
    }

    // -----------------------------------------------------
    // VALIDATE ENROLLMENT
    // -----------------------------------------------------

    if (!enrollment || !enrollment.trim()) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const cleanName = studentName.trim();

    const cleanEnrollment = enrollment.trim().toUpperCase();

    // -----------------------------------------------------
    // GET QUIZ
    // -----------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found or no longer available.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // CHECK QUIZ STATUS
    // -----------------------------------------------------

    if (quiz.status && quiz.status !== "live") {
      return res.status(403).json({
        success: false,
        error: "This quiz is no longer accepting students.",
      });
    }

    // -----------------------------------------------------
    // TIME LIMIT
    // -----------------------------------------------------

    const timeLimit = Number(quiz.timeLimit) || 30;

    // -----------------------------------------------------
    // STUDENT DOCUMENT
    //
    // Enrollment number is used as document ID.
    //
    // Example:
    //
    // quizzes
    //   STXABC123
    //      students
    //         BCA001
    //
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(cleanEnrollment);

    // -----------------------------------------------------
    // FIRESTORE TRANSACTION
    //
    // Prevents duplicate enrollment attempts even if
    // two requests arrive at almost the same time.
    // -----------------------------------------------------

    const result = await db.runTransaction(async (transaction) => {
      const studentSnapshot = await transaction.get(studentRef);

      // ---------------------------------------------------
      // DUPLICATE CHECK
      // ---------------------------------------------------

      if (studentSnapshot.exists) {
        throw new Error("DUPLICATE_ENROLLMENT");
      }

      // ---------------------------------------------------
      // SERVER-CONTROLLED TIME
      // ---------------------------------------------------

      const startedAt = new Date();

      const expiresAt = new Date(startedAt.getTime() + timeLimit * 60 * 1000);

      // ---------------------------------------------------
      // CREATE STUDENT ATTEMPT
      // ---------------------------------------------------

      const studentId = `${code}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;

      const student = {
        id: studentId,

        studentName: cleanName,

        enrollment: cleanEnrollment,

        joinedAt: startedAt.toISOString(),

        startedAt: startedAt.toISOString(),

        expiresAt: expiresAt.toISOString(),

        timeLimit,

        status: "in_progress",

        submitted: false,

        submittedAt: null,

        score: null,

        totalMarks: Number(quiz.totalMarks) || 0,

        answers: {},
      };

      // ---------------------------------------------------
      // SAVE STUDENT
      // ---------------------------------------------------

      transaction.set(studentRef, student);

      // ---------------------------------------------------
      // UPDATE STUDENT COUNT
      // ---------------------------------------------------

      const currentTotalStudents = Number(quiz.totalStudents || 0);

      transaction.update(quizRef, {
        totalStudents: currentTotalStudents + 1,
      });

      return {
        student,
        totalStudents: currentTotalStudents + 1,
      };
    });

    // -----------------------------------------------------
    // LOG
    // -----------------------------------------------------

    console.log(
      `Student started quiz ${code}: ${cleanName} (${cleanEnrollment})`,
    );

    console.log(`Timer: ${timeLimit} minutes`);

    console.log(`Expires at: ${result.student.expiresAt}`);

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      message: "Quiz started successfully.",

      student: {
        id: result.student.id,

        studentName: result.student.studentName,

        enrollment: result.student.enrollment,

        startedAt: result.student.startedAt,

        expiresAt: result.student.expiresAt,

        timeLimit: result.student.timeLimit,

        status: result.student.status,
      },

      totalStudents: result.totalStudents,

      // ---------------------------------------------------
      // IMPORTANT
      //
      // We return the server time so frontend can calculate
      // remaining time more accurately.
      // ---------------------------------------------------

      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    // -----------------------------------------------------
    // DUPLICATE ENROLLMENT
    // -----------------------------------------------------

    if (error.message === "DUPLICATE_ENROLLMENT") {
      return res.status(409).json({
        success: false,
        error: "This enrollment number has already joined this test.",
      });
    }

    // -----------------------------------------------------
    // OTHER ERROR
    // -----------------------------------------------------

    console.error("STUDENT JOIN ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to start quiz.",
    });
  }
});

// =========================================================
// STUDENT JOIN QUIZ
// =========================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const { studentName, enrollment } = req.body;

    // ---------------------------------------------------
    // VALIDATE NAME
    // ---------------------------------------------------

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({
        success: false,

        error: "Student name is required.",
      });
    }

    // ---------------------------------------------------
    // VALIDATE ENROLLMENT
    // ---------------------------------------------------

    if (!enrollment || !enrollment.trim()) {
      return res.status(400).json({
        success: false,

        error: "Enrollment number is required.",
      });
    }

    const cleanName = studentName.trim();

    const cleanEnrollment = enrollment.trim().toUpperCase();

    // ---------------------------------------------------
    // CHECK QUIZ
    // ---------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,

        error: "Quiz not found or no longer available.",
      });
    }

    const quiz = quizSnapshot.data();

    // ---------------------------------------------------
    // CHECK STATUS
    // ---------------------------------------------------

    if (quiz.status && quiz.status !== "live") {
      return res.status(403).json({
        success: false,

        error: "This quiz is no longer accepting students.",
      });
    }

    // ---------------------------------------------------
    // STUDENT DOCUMENT
    //
    // Enrollment number becomes the document ID.
    //
    // This gives us:
    //
    // quizzes
    //   STXABC123
    //      students
    //         ENROLL001
    //
    // Therefore the same enrollment number
    // cannot join the same quiz twice.
    // ---------------------------------------------------

    const studentRef = quizRef.collection("students").doc(cleanEnrollment);

    // ---------------------------------------------------
    // CHECK DUPLICATE
    // ---------------------------------------------------

    const existingStudent = await studentRef.get();

    if (existingStudent.exists) {
      return res.status(409).json({
        success: false,

        error: "This enrollment number has already joined this test.",
      });
    }

    // ---------------------------------------------------
    // CREATE STUDENT
    // ---------------------------------------------------

    const studentId = `${code}-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;

    const joinedAt = new Date().toISOString();

    const student = {
      id: studentId,

      studentName: cleanName,

      enrollment: cleanEnrollment,

      joinedAt,

      status: "joined",

      submitted: false,

      score: null,
    };

    // ---------------------------------------------------
    // SAVE STUDENT
    // ---------------------------------------------------

    await studentRef.set(student);

    // ---------------------------------------------------
    // UPDATE TOTAL STUDENTS
    // ---------------------------------------------------

    const newTotalStudents = Number(quiz.totalStudents || 0) + 1;

    await quizRef.update({
      totalStudents: newTotalStudents,
    });

    console.log(`Student joined ${code}: ${cleanName} (${cleanEnrollment})`);

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

    res.json({
      success: true,

      message: "Successfully joined the quiz.",

      student: {
        id: student.id,

        studentName: student.studentName,

        enrollment: student.enrollment,

        joinedAt: student.joinedAt,
      },

      totalStudents: newTotalStudents,
    });
  } catch (error) {
    console.error("STUDENT JOIN ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to join quiz.",
    });
  }
});

// =========================================================
// GET QUIZ BY CODE
// =========================================================
// PUBLIC STUDENT VERSION
// Does NOT expose correct answers.
// =========================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const quizSnapshot = await db.collection("quizzes").doc(code).get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found or no longer available.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // REMOVE ANSWER KEY
    // -----------------------------------------------------

    const safeQuestions = (quiz.questions || []).map((question) => ({
      question: question.question,

      options: question.options,

      marks: question.marks,

      difficulty: question.difficulty,
    }));

    // -----------------------------------------------------
    // STUDENT-SAFE QUIZ
    // -----------------------------------------------------

    const safeQuiz = {
      code: quiz.code,

      status: quiz.status,

      createdAt: quiz.createdAt,

      timeLimit: quiz.timeLimit,

      totalQuestions: quiz.totalQuestions,

      marksPerQuestion: quiz.marksPerQuestion,

      totalMarks: quiz.totalMarks,

      totalStudents: quiz.totalStudents || 0,

      questions: safeQuestions,
    };

    res.json({
      success: true,

      quiz: safeQuiz,
    });
  } catch (error) {
    console.error("GET QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to load quiz.",
    });
  }
});

// =========================================================
// GET LIVE STUDENT COUNT
// =========================================================

app.get("/quiz/:code/student-count", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const quizSnapshot = await db.collection("quizzes").doc(code).get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,

        error: "Quiz not found.",
      });
    }

    const studentsSnapshot = await db
      .collection("quizzes")
      .doc(code)
      .collection("students")
      .get();

    const totalStudents = studentsSnapshot.size;

    res.json({
      success: true,

      quizCode: code,

      totalStudents,
    });
  } catch (error) {
    console.error("GET STUDENT COUNT ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to get student count.",
    });
  }
});

// =========================================================
// SERVER
// =========================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const pdf = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

require("dotenv").config();

// =========================================================
// ENVIRONMENT
// =========================================================

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "GEMINI_API_KEY",
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error("❌ Missing required environment variables:");
  console.error(missingEnv.join(", "));
  process.exit(1);
}

// =========================================================
// FIREBASE
// =========================================================

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,

      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,

      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();

console.log("✅ Firebase Admin initialized successfully.");

// =========================================================
// EXPRESS
// =========================================================

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =========================================================
// TEMPORARY PDF CONTEXT
// =========================================================
//
// Used only for regenerating a question after generating
// a quiz.
//
// NOTE:
// This is server memory and is therefore suitable for the
// MVP/test. For production, store the source material
// securely per quiz.
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

function getGeminiModel() {
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });
}

// =========================================================
// HELPERS
// =========================================================

function cleanGeminiResponse(text) {
  let cleaned = text.trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned
      .replace(/^```json/, "")
      .replace(/```$/, "")
      .trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
  }

  return cleaned;
}

function parseGeminiJSON(text) {
  const cleaned = cleanGeminiResponse(text);

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("❌ Invalid Gemini JSON:");
    console.error(text);

    throw new Error("AI returned an invalid JSON format.");
  }
}

function validateQuestion(question) {
  return (
    question &&
    typeof question.question === "string" &&
    question.question.trim().length > 0 &&
    Array.isArray(question.options) &&
    question.options.length === 4 &&
    question.options.every(
      (option) => typeof option === "string" && option.trim().length > 0,
    ) &&
    Number.isInteger(question.correctAnswer) &&
    question.correctAnswer >= 0 &&
    question.correctAnswer <= 3
  );
}

function generateQuizCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "STX";

  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return code;
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function normalizeEnrollment(enrollment) {
  return String(enrollment || "")
    .trim()
    .toUpperCase();
}

function normalizeStudentName(studentName) {
  return String(studentName || "").trim();
}

// =========================================================
// HOME / HEALTH CHECK
// =========================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Advance's Quiz Backend Running!",
    firebase: true,
    timestamp: new Date().toISOString(),
  });
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

    const timeLimit = Number(req.body.timeLimit) || 30;

    console.log("==========================================");
    console.log("📄 PDF received:", req.file.originalname);
    console.log("❓ Questions:", numberOfQuestions);
    console.log("⭐ Marks/question:", marksPerQuestion);
    console.log("🎯 Difficulty:", difficulty);
    console.log("⏱️ Time limit:", timeLimit, "minutes");
    console.log("==========================================");

    // -----------------------------------------------------
    // READ PDF
    // -----------------------------------------------------

    const dataBuffer = fs.readFileSync(filePath);

    const pdfData = await pdf(dataBuffer);

    const extractedText = pdfData.text.trim();

    if (!extractedText) {
      throw new Error(
        "Could not extract text from this PDF. It may be an image/scanned PDF.",
      );
    }

    console.log("📚 Extracted characters:", extractedText.length);

    // -----------------------------------------------------
    // SAVE PDF CONTEXT
    // -----------------------------------------------------

    lastPdfText = extractedText.slice(0, 60000);

    // -----------------------------------------------------
    // GEMINI
    // -----------------------------------------------------

    const model = getGeminiModel();

    // -----------------------------------------------------
    // PROMPT
    // -----------------------------------------------------

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

Return exactly this structure:

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
- 0 = Option A.
- 1 = Option B.
- 2 = Option C.
- 3 = Option D.
- Do not include markdown.
- Do not include code fences.
- Return JSON only.

STUDY MATERIAL:

${lastPdfText}
`;

    console.log("🤖 Generating questions with Gemini...");

    const result = await model.generateContent(prompt);

    const responseText = result.response.text();

    console.log("✅ Gemini response received.");

    // -----------------------------------------------------
    // PARSE JSON
    // -----------------------------------------------------

    const quizData = parseGeminiJSON(responseText);

    // -----------------------------------------------------
    // VALIDATE QUESTIONS ARRAY
    // -----------------------------------------------------

    if (!quizData || !Array.isArray(quizData.questions)) {
      throw new Error("AI did not return a valid question list.");
    }

    // -----------------------------------------------------
    // VALIDATE QUESTIONS
    // -----------------------------------------------------

    const validQuestions = quizData.questions
      .slice(0, numberOfQuestions)
      .filter(validateQuestion)
      .map((question) => ({
        question: question.question.trim(),

        options: question.options.map((option) => option.trim()),

        correctAnswer: question.correctAnswer,

        explanation:
          typeof question.explanation === "string"
            ? question.explanation.trim()
            : "",

        marks: marksPerQuestion,

        difficulty,
      }));

    // -----------------------------------------------------
    // CHECK RESULT
    // -----------------------------------------------------

    if (validQuestions.length === 0) {
      throw new Error("No valid questions were generated.");
    }

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

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
    console.error("❌ GENERATE QUIZ ERROR:");
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
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.error("⚠️ Failed to delete temporary PDF:", cleanupError);
      }
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
        success: false,

        error: "PDF context not found. Please generate the quiz again.",
      });
    }

    const selectedDifficulty = req.body.difficulty || "moderate";

    const previousQuestion = req.body.previousQuestion || "None";

    // -----------------------------------------------------
    // GEMINI
    // -----------------------------------------------------

    const model = getGeminiModel();

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

${previousQuestion}

Return exactly this structure:

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

    console.log("🔄 Regenerating question...");
    console.log("🎯 Difficulty:", selectedDifficulty);

    const result = await model.generateContent(prompt);

    const responseText = result.response.text();

    console.log("✅ Gemini regeneration response received.");

    // -----------------------------------------------------
    // PARSE
    // -----------------------------------------------------

    const newQuestion = parseGeminiJSON(responseText);

    // -----------------------------------------------------
    // VALIDATE
    // -----------------------------------------------------

    if (!validateQuestion(newQuestion)) {
      throw new Error("AI returned an invalid question.");
    }

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      question: {
        question: newQuestion.question.trim(),

        options: newQuestion.options.map((option) => option.trim()),

        correctAnswer: newQuestion.correctAnswer,

        explanation:
          typeof newQuestion.explanation === "string"
            ? newQuestion.explanation.trim()
            : "",

        difficulty: selectedDifficulty,
      },
    });
  } catch (error) {
    console.error("❌ REGENERATE QUESTION ERROR:");

    console.error(error);

    res.status(500).json({
      success: false,

      error: error.message || "Failed to regenerate question.",
    });
  }
});

// =========================================================
// PUBLISH QUIZ
// =========================================================

app.post("/publish-quiz", async (req, res) => {
  try {
    const { quiz } = req.body;

    // -----------------------------------------------------
    // VALIDATE QUIZ
    // -----------------------------------------------------

    if (
      !quiz ||
      !Array.isArray(quiz.questions) ||
      quiz.questions.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid quiz data.",
      });
    }

    // -----------------------------------------------------
    // GENERATE UNIQUE CODE
    // -----------------------------------------------------

    let code;
    let quizRef;
    let quizSnapshot;

    do {
      code = generateQuizCode();

      quizRef = db.collection("quizzes").doc(code);

      quizSnapshot = await quizRef.get();
    } while (quizSnapshot.exists);

    // -----------------------------------------------------
    // SETTINGS
    // -----------------------------------------------------

    const timeLimit = Number(quiz.timeLimit) || 30;

    const totalQuestions = quiz.questions.length;

    const marksPerQuestion = Number(quiz.marksPerQuestion) || 1;

    const totalMarks =
      Number(quiz.totalMarks) || totalQuestions * marksPerQuestion;

    // -----------------------------------------------------
    // QUIZ DATA
    // -----------------------------------------------------

    const quizData = {
      ...quiz,

      code,

      status: "live",

      createdAt: new Date().toISOString(),

      timeLimit,

      totalQuestions,

      marksPerQuestion,

      totalMarks,

      totalStudents: 0,
    };

    // -----------------------------------------------------
    // SAVE
    // -----------------------------------------------------

    await quizRef.set(quizData);

    console.log("==========================================");

    console.log("✅ Quiz published to Firestore:", code);

    console.log("Questions:", totalQuestions);

    console.log("Time:", timeLimit, "minutes");

    console.log("==========================================");

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      code,

      quiz: quizData,
    });
  } catch (error) {
    console.error("❌ PUBLISH QUIZ ERROR:");
    console.error(error);

    res.status(500).json({
      success: false,

      error: error.message || "Failed to publish quiz.",
    });
  }
});

// =========================================================
// GET QUIZ BY CODE
// =========================================================
//
// IMPORTANT:
// Correct answers are NEVER sent to students.
// =========================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

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
    // CHECK STATUS
    // -----------------------------------------------------

    if (quiz.status && quiz.status !== "live") {
      return res.status(403).json({
        success: false,

        error: "This quiz is no longer available.",
      });
    }

    // -----------------------------------------------------
    // REMOVE ANSWER KEY
    // -----------------------------------------------------

    const safeQuestions = Array.isArray(quiz.questions)
      ? quiz.questions.map((question) => ({
          question: question.question,

          options: question.options,

          marks: question.marks,

          difficulty: question.difficulty,
        }))
      : [];

    // -----------------------------------------------------
    // STUDENT-SAFE QUIZ
    // -----------------------------------------------------

    const safeQuiz = {
      code: quiz.code,

      status: quiz.status,

      createdAt: quiz.createdAt,

      timeLimit: quiz.timeLimit,

      totalQuestions: quiz.totalQuestions || safeQuestions.length,

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
    console.error("❌ GET QUIZ ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to load quiz.",
    });
  }
});

// =========================================================
// STUDENT JOIN QUIZ + START ATTEMPT
// =========================================================
//
// ONE JOIN ROUTE ONLY.
//
// Firestore document:
//
// quizzes/{CODE}/students/{ENROLLMENT}
//
// Therefore:
//
// Same quiz + same enrollment
// = duplicate
//
// Different quiz + same enrollment
// = allowed
//
// =========================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const studentName = normalizeStudentName(req.body.studentName);

    const enrollment = normalizeEnrollment(req.body.enrollment);

    // -----------------------------------------------------
    // VALIDATE CODE
    // -----------------------------------------------------

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

    // -----------------------------------------------------
    // VALIDATE NAME
    // -----------------------------------------------------

    if (!studentName) {
      return res.status(400).json({
        success: false,
        error: "Student name is required.",
      });
    }

    // -----------------------------------------------------
    // VALIDATE ENROLLMENT
    // -----------------------------------------------------

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    // -----------------------------------------------------
    // QUIZ REFERENCE
    // -----------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    // -----------------------------------------------------
    // GET QUIZ
    // -----------------------------------------------------

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,

        error: "Quiz not found or no longer available.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // CHECK STATUS
    // -----------------------------------------------------

    if (quiz.status && quiz.status !== "live") {
      return res.status(403).json({
        success: false,

        error: "This quiz is no longer accepting students.",
      });
    }

    // -----------------------------------------------------
    // TIMER
    // -----------------------------------------------------

    const timeLimit = Number(quiz.timeLimit) || 30;

    // -----------------------------------------------------
    // STUDENT DOCUMENT
    // -----------------------------------------------------
    //
    // The enrollment number is the document ID.
    //
    // quizzes
    //   STXABC123
    //      students
    //         BCA001
    //
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(enrollment);

    // -----------------------------------------------------
    // TRANSACTION
    // -----------------------------------------------------
    //
    // This is important.
    //
    // A normal "check then create" can still allow
    // duplicates if two requests arrive simultaneously.
    //
    // Firestore transaction prevents that race.
    // -----------------------------------------------------

    const result = await db.runTransaction(async (transaction) => {
      const studentSnapshot = await transaction.get(studentRef);

      // ------------------------------------------------
      // DUPLICATE
      // ------------------------------------------------

      if (studentSnapshot.exists) {
        const duplicateError = new Error("DUPLICATE_ENROLLMENT");

        duplicateError.code = "DUPLICATE_ENROLLMENT";

        throw duplicateError;
      }

      // ------------------------------------------------
      // SERVER TIME
      // ------------------------------------------------

      const startedAt = new Date();

      const expiresAt = new Date(startedAt.getTime() + timeLimit * 60 * 1000);

      // ------------------------------------------------
      // STUDENT ID
      // ------------------------------------------------

      const studentId = `${code}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;

      // ------------------------------------------------
      // STUDENT DATA
      // ------------------------------------------------

      const student = {
        id: studentId,

        studentName,

        enrollment,

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

      // ------------------------------------------------
      // SAVE STUDENT
      // ------------------------------------------------

      transaction.set(studentRef, student);

      // ------------------------------------------------
      // UPDATE COUNT
      // ------------------------------------------------

      const currentTotalStudents = Number(quiz.totalStudents || 0);

      const newTotalStudents = currentTotalStudents + 1;

      transaction.update(quizRef, {
        totalStudents: newTotalStudents,
      });

      return {
        student,

        totalStudents: newTotalStudents,
      };
    });

    // -----------------------------------------------------
    // LOG
    // -----------------------------------------------------

    console.log(
      `✅ Student started quiz ${code}: ${studentName} (${enrollment})`,
    );

    console.log(`⏱️ Timer: ${timeLimit} minutes`);

    console.log(`⏰ Expires: ${result.student.expiresAt}`);

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

      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    // -----------------------------------------------------
    // DUPLICATE ENROLLMENT
    // -----------------------------------------------------

    if (
      error.code === "DUPLICATE_ENROLLMENT" ||
      error.message === "DUPLICATE_ENROLLMENT"
    ) {
      return res.status(409).json({
        success: false,

        error: "This enrollment number has already joined this test.",
      });
    }

    // -----------------------------------------------------
    // OTHER ERROR
    // -----------------------------------------------------

    console.error("❌ STUDENT JOIN ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to start quiz.",
    });
  }
});

// =========================================================
// SUBMIT QUIZ
// =========================================================

app.post("/quiz/:code/submit", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const { enrollment, answers = {} } = req.body;

    // -----------------------------------------------------
    // VALIDATE ENROLLMENT
    // -----------------------------------------------------

    if (!enrollment || !enrollment.trim()) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const cleanEnrollment = enrollment.trim().toUpperCase();

    // -----------------------------------------------------
    // GET QUIZ
    // -----------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // GET STUDENT
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(cleanEnrollment);

    const studentSnapshot = await studentRef.get();

    if (!studentSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Student has not joined this quiz.",
      });
    }

    const student = studentSnapshot.data();

    // -----------------------------------------------------
    // CHECK ALREADY SUBMITTED
    // -----------------------------------------------------

    if (student.submitted === true) {
      return res.status(409).json({
        success: false,
        error: "Quiz has already been submitted.",
      });
    }

    // -----------------------------------------------------
    // CHECK QUESTIONS
    // -----------------------------------------------------

    if (!Array.isArray(quiz.questions)) {
      return res.status(500).json({
        success: false,
        error: "Quiz questions are missing.",
      });
    }

    // -----------------------------------------------------
    // CHECK TIMER
    // -----------------------------------------------------

    const now = new Date();

    const expiresAt = student.expiresAt ? new Date(student.expiresAt) : null;

    const isTimeExpired = expiresAt && now.getTime() >= expiresAt.getTime();

    // -----------------------------------------------------
    // CALCULATE SCORE
    // -----------------------------------------------------

    let score = 0;
    let correctAnswers = 0;
    let wrongAnswers = 0;
    let unanswered = 0;

    const processedAnswers = {};

    quiz.questions.forEach((question, index) => {
      const submittedAnswer = answers[index];

      const hasAnswer =
        submittedAnswer !== undefined &&
        submittedAnswer !== null &&
        submittedAnswer !== "";

      const selectedAnswer = hasAnswer ? Number(submittedAnswer) : null;

      const correctAnswer = Number(question.correctAnswer);

      let isCorrect = false;

      if (!hasAnswer) {
        unanswered++;
      } else if (
        Number.isInteger(selectedAnswer) &&
        selectedAnswer >= 0 &&
        selectedAnswer <= 3
      ) {
        if (selectedAnswer === correctAnswer) {
          isCorrect = true;

          correctAnswers++;

          score += Number(question.marks || 1);
        } else {
          wrongAnswers++;
        }
      } else {
        unanswered++;
      }

      processedAnswers[index] = {
        selectedAnswer,
        correctAnswer,
        isCorrect,
        marks: isCorrect ? Number(question.marks || 1) : 0,
      };
    });

    // -----------------------------------------------------
    // TOTAL MARKS
    // -----------------------------------------------------

    const totalMarks =
      Number(quiz.totalMarks) ||
      quiz.questions.reduce(
        (total, question) => total + Number(question.marks || 1),
        0,
      );

    // -----------------------------------------------------
    // PERCENTAGE
    // -----------------------------------------------------

    const percentage =
      totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(2)) : 0;

    // -----------------------------------------------------
    // SUBMISSION STATUS
    // -----------------------------------------------------

    const submissionStatus = isTimeExpired ? "auto_submitted" : "submitted";

    const submittedAt = now.toISOString();

    // -----------------------------------------------------
    // SAVE RESULT
    // -----------------------------------------------------

    await studentRef.update({
      answers: processedAnswers,

      score,

      totalMarks,

      percentage,

      correctAnswers,

      wrongAnswers,

      unanswered,

      submitted: true,

      submittedAt,

      status: submissionStatus,
    });

    console.log(`Quiz submitted: ${code} - ${cleanEnrollment}`);

    console.log(`Score: ${score}/${totalMarks} (${percentage}%)`);

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      message: isTimeExpired
        ? "Time expired. Quiz was automatically submitted."
        : "Quiz submitted successfully.",

      quizCode: code,

      enrollment: cleanEnrollment,

      score,

      totalMarks,

      percentage,

      correctAnswers,

      wrongAnswers,

      unanswered,

      submittedAt,

      status: submissionStatus,
    });
  } catch (error) {
    console.error("SUBMIT QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to submit quiz.",
    });
  }
});

// =========================================================
// VIEW QUIZ RESULT / SCORE
// =========================================================

app.get("/quiz/:code/result/:enrollment", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const enrollment = req.params.enrollment.trim().toUpperCase();

    // -----------------------------------------------------
    // GET QUIZ
    // -----------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // GET STUDENT
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(enrollment);

    const studentSnapshot = await studentRef.get();

    if (!studentSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Student result not found.",
      });
    }

    const student = studentSnapshot.data();

    // -----------------------------------------------------
    // CHECK SUBMISSION
    // -----------------------------------------------------

    if (!student.submitted) {
      return res.status(400).json({
        success: false,
        error: "Quiz has not been submitted yet.",
      });
    }

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      result: {
        quizCode: code,

        studentName: student.studentName,

        enrollment: student.enrollment,

        score: Number(student.score || 0),

        totalMarks: Number(student.totalMarks || 0),

        percentage: Number(student.percentage || 0),

        correctAnswers: Number(student.correctAnswers || 0),

        wrongAnswers: Number(student.wrongAnswers || 0),

        unanswered: Number(student.unanswered || 0),

        submittedAt: student.submittedAt,

        status: student.status,

        totalQuestions: Array.isArray(quiz.questions)
          ? quiz.questions.length
          : 0,
      },
    });
  } catch (error) {
    console.error("GET RESULT ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to load result.",
    });
  }
});

// =========================================================
// REVIEW QUIZ ANSWERS
// =========================================================

app.get("/quiz/:code/review/:enrollment", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const enrollment = req.params.enrollment.trim().toUpperCase();

    // -----------------------------------------------------
    // GET QUIZ
    // -----------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    // -----------------------------------------------------
    // GET STUDENT
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(enrollment);

    const studentSnapshot = await studentRef.get();

    if (!studentSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Student not found.",
      });
    }

    const student = studentSnapshot.data();

    // -----------------------------------------------------
    // CHECK SUBMISSION
    // -----------------------------------------------------

    if (!student.submitted) {
      return res.status(403).json({
        success: false,
        error: "Answer review is available only after submission.",
      });
    }

    // -----------------------------------------------------
    // BUILD REVIEW
    // -----------------------------------------------------

    const savedAnswers = student.answers || {};

    const review = (quiz.questions || []).map((question, index) => {
      const answerData = savedAnswers[index] || {};

      const selectedAnswer =
        answerData.selectedAnswer !== undefined
          ? answerData.selectedAnswer
          : null;

      const correctAnswer = Number(question.correctAnswer);

      const isCorrect =
        selectedAnswer !== null && Number(selectedAnswer) === correctAnswer;

      return {
        questionNumber: index + 1,

        question: question.question,

        options: question.options,

        selectedAnswer,

        correctAnswer,

        isCorrect,

        marks: Number(question.marks || 1),

        marksObtained: isCorrect ? Number(question.marks || 1) : 0,

        explanation: question.explanation || "",

        difficulty: question.difficulty || "",
      };
    });

    // -----------------------------------------------------
    // RESPONSE
    // -----------------------------------------------------

    res.json({
      success: true,

      quizCode: code,

      student: {
        studentName: student.studentName,

        enrollment: student.enrollment,
      },

      result: {
        score: Number(student.score || 0),

        totalMarks: Number(student.totalMarks || 0),

        percentage: Number(student.percentage || 0),

        correctAnswers: Number(student.correctAnswers || 0),

        wrongAnswers: Number(student.wrongAnswers || 0),

        unanswered: Number(student.unanswered || 0),
      },

      review,
    });
  } catch (error) {
    console.error("REVIEW ANSWERS ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to load answer review.",
    });
  }
});

// =========================================================
// GET STUDENTS OF QUIZ
// =========================================================
//
// This endpoint is primarily for the teacher/admin side.
// =========================================================

app.get("/quiz/:code/students", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

    // ---------------------------------------------------
    // CHECK QUIZ
    // ---------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,

        error: "Quiz not found.",
      });
    }

    // ---------------------------------------------------
    // GET STUDENTS
    // ---------------------------------------------------

    const studentsSnapshot = await quizRef
      .collection("students")
      .orderBy("joinedAt", "asc")
      .get();

    const students = studentsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

    res.json({
      success: true,

      quizCode: code,

      totalStudents: students.length,

      students,
    });
  } catch (error) {
    console.error("❌ GET STUDENTS ERROR:", error);

    res.status(500).json({
      success: false,

      error: "Failed to load students.",
    });
  }
});

// =========================================================
// GET LIVE STUDENT COUNT
// =========================================================

app.get("/quiz/:code/student-count", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

    // ---------------------------------------------------
    // CHECK QUIZ
    // ---------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,

        error: "Quiz not found.",
      });
    }

    // ---------------------------------------------------
    // COUNT STUDENTS
    // ---------------------------------------------------

    const studentsSnapshot = await quizRef.collection("students").get();

    const totalStudents = studentsSnapshot.size;

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

    res.json({
      success: true,

      quizCode: code,

      totalStudents,
    });
  } catch (error) {
    console.error("❌ GET STUDENT COUNT ERROR:", error);

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
  console.log("==========================================");

  console.log(`🚀 Advance's Quiz Backend running on port ${PORT}`);

  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);

  console.log("==========================================");
});

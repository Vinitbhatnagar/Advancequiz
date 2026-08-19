// ============================================================
// ADVANCE'S QUIZ - SERVER
// Firebase Firestore + Gemini AI
// Compatible with the provided React App.js
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const crypto = require("crypto");

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 5000;

const MAX_QUIZ_TIME = 180;
const DEFAULT_QUIZ_TIME = 30;

// ============================================================
// FIREBASE ADMIN
// ============================================================

let db;

try {
  // ----------------------------------------------------------
  // OPTION 1:
  // FIREBASE_SERVICE_ACCOUNT_JSON
  //
  // Recommended for Render.
  // ----------------------------------------------------------

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  // ----------------------------------------------------------
  // OPTION 2:
  // Individual Firebase environment variables
  // ----------------------------------------------------------
  else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,

        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,

        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }

  // ----------------------------------------------------------
  // OPTION 3:
  // Local Firebase credentials
  // ----------------------------------------------------------
  else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  db = admin.firestore();

  console.log("Firebase initialized successfully.");
} catch (error) {
  console.error("FIREBASE INITIALIZATION ERROR:");
  console.error(error);

  process.exit(1);
}

// ============================================================
// GEMINI
// ============================================================

if (!process.env.GEMINI_API_KEY) {
  console.error("WARNING: GEMINI_API_KEY is missing.");
}

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ============================================================
// MULTER
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },

  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed."));
    }
  },
});

// ============================================================
// HELPERS
// ============================================================

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

function cleanText(value) {
  return String(value || "").trim();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function generateQuizCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 6; i++) {
    code += characters[crypto.randomInt(0, characters.length)];
  }

  return code;
}

async function createUniqueQuizCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateQuizCode();

    const snapshot = await db.collection("quizzes").doc(code).get();

    if (!snapshot.exists) {
      return code;
    }
  }

  throw new Error("Could not generate a unique quiz code.");
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof admin.firestore.Timestamp) {
    return value.toDate();
  }

  if (value instanceof Date) {
    return value;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function serializeTimestamp(value) {
  const date = safeDate(value);

  return date ? date.toISOString() : null;
}

function sanitizeQuestionForStudent(question, index) {
  return {
    id: question.id ?? index + 1,

    question: cleanText(question.question),

    options: Array.isArray(question.options)
      ? question.options.map((option) => cleanText(option))
      : [],

    difficulty: question.difficulty || "moderate",

    marks: Number(question.marks || 1),

    source: question.source || "ai",

    excluded: false,
  };
}

function sanitizeQuizForStudent(quiz) {
  return {
    code: quiz.code,

    title: quiz.title || "Advance's Quiz",

    totalQuestions: quiz.totalQuestions || quiz.questions.length,

    totalMarks: quiz.totalMarks || 0,

    marksPerQuestion: quiz.marksPerQuestion || 0,

    difficulty: quiz.difficulty || "mixed",

    timeLimit: Number(quiz.timeLimit || DEFAULT_QUIZ_TIME),

    questions: quiz.questions.map(sanitizeQuestionForStudent),
  };
}

function normalizeQuestion(question, index, defaults = {}) {
  const options = Array.isArray(question.options)
    ? question.options.slice(0, 4).map((option) => cleanText(option))
    : [];

  while (options.length < 4) {
    options.push("");
  }

  let correctAnswer = Number(question.correctAnswer);

  if (
    !Number.isInteger(correctAnswer) ||
    correctAnswer < 0 ||
    correctAnswer > 3
  ) {
    correctAnswer = 0;
  }

  const difficulty = question.difficulty || defaults.difficulty || "moderate";

  const marks = Number(question.marks || defaults.marks || 1);

  return {
    id: question.id ?? index + 1,

    question: cleanText(question.question),

    options,

    correctAnswer,

    explanation: cleanText(question.explanation),

    difficulty,

    marks: Number.isFinite(marks) && marks > 0 ? marks : 1,

    excluded: Boolean(question.excluded),

    source: question.source || defaults.source || "ai",
  };
}

// ============================================================
// GEMINI JSON EXTRACTION
// ============================================================

function extractJson(text) {
  if (!text) {
    throw new Error("AI returned an empty response.");
  }

  let cleaned = String(text).trim();

  // Remove markdown code fences.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Direct JSON.
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Find JSON object.
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd !== -1) {
    const objectText = cleaned.slice(objectStart, objectEnd + 1);

    try {
      return JSON.parse(objectText);
    } catch (_) {}
  }

  // Find JSON array.
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd !== -1) {
    const arrayText = cleaned.slice(arrayStart, arrayEnd + 1);

    try {
      return JSON.parse(arrayText);
    } catch (_) {}
  }

  throw new Error("AI returned invalid JSON.");
}

// ============================================================
// GEMINI CALL
// ============================================================

async function askGemini(prompt) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const model = genAI.getGenerativeModel({
    model: modelName,
  });

  const result = await model.generateContent(prompt);

  const response = result.response;

  const text = response.text();

  return text;
}

// ============================================================
// HEALTH
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Advance's Quiz server is running.",
    database: "Firebase Firestore",
    ai: process.env.GEMINI_API_KEY ? "configured" : "missing",
  });
});

app.get("/health", async (req, res) => {
  try {
    await db.collection("quizzes").limit(1).get();

    res.json({
      success: true,
      server: "online",
      firebase: "connected",
      gemini: process.env.GEMINI_API_KEY ? "configured" : "missing",
      time: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Firebase connection failed.",
      details: error.message,
    });
  }
});

// ============================================================
// GENERATE QUIZ
// POST /generate-quiz
// ============================================================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a PDF.",
      });
    }

    const numberOfQuestions = clampNumber(
      req.body.numberOfQuestions,
      1,
      50,
      10,
    );

    const marksPerQuestion = clampNumber(req.body.marksPerQuestion, 1, 20, 2);

    const difficulty = ["easy", "moderate", "hard"].includes(
      String(req.body.difficulty || "").toLowerCase(),
    )
      ? String(req.body.difficulty).toLowerCase()
      : "moderate";

    const timeLimit = clampNumber(
      req.body.timeLimit,
      1,
      MAX_QUIZ_TIME,
      DEFAULT_QUIZ_TIME,
    );

    console.log(
      `Generating ${numberOfQuestions} questions | ${difficulty} | ${timeLimit} minutes`,
    );

    // --------------------------------------------------------
    // READ PDF
    // --------------------------------------------------------

    const pdfData = await pdfParse(req.file.buffer);

    let pdfText = cleanText(pdfData.text);

    if (!pdfText) {
      return res.status(400).json({
        success: false,
        error:
          "Could not extract text from this PDF. The PDF may be scanned/image-only.",
      });
    }

    // Avoid sending an enormous document to Gemini.
    const MAX_PDF_TEXT = 120000;

    if (pdfText.length > MAX_PDF_TEXT) {
      pdfText = pdfText.slice(0, MAX_PDF_TEXT);
    }

    // --------------------------------------------------------
    // GEMINI PROMPT
    // --------------------------------------------------------

    const prompt = `
You are an expert college-level examination question generator.

Create exactly ${numberOfQuestions} high-quality multiple-choice questions
from the study material provided below.

REQUIREMENTS:

1. Difficulty: ${difficulty}
2. Each question must have exactly 4 options.
3. Only ONE option must be correct.
4. correctAnswer must be a zero-based integer:
   - 0 = option A
   - 1 = option B
   - 2 = option C
   - 3 = option D
5. Every question must be answerable from the provided study material.
6. Do not create questions from information not contained in the material.
7. Avoid duplicate or nearly duplicate questions.
8. Questions should test understanding, not just meaningless memorization.
9. Use clear college-level English.
10. Include a concise explanation for the correct answer.
11. Marks for every question: ${marksPerQuestion}.
12. Difficulty for every question: ${difficulty}.
13. Return ONLY valid JSON.
14. Do NOT use markdown.
15. Do NOT put JSON inside code fences.

RETURN EXACTLY THIS STRUCTURE:

{
  "success": true,
  "totalQuestions": ${numberOfQuestions},
  "marksPerQuestion": ${marksPerQuestion},
  "totalMarks": ${numberOfQuestions * marksPerQuestion},
  "difficulty": "${difficulty}",
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
      "explanation": "Why this answer is correct.",
      "difficulty": "${difficulty}",
      "marks": ${marksPerQuestion}
    }
  ]
}

STUDY MATERIAL:

${pdfText}
`;

    const aiText = await askGemini(prompt);

    const parsed = extractJson(aiText);

    if (
      !parsed ||
      !Array.isArray(parsed.questions) ||
      parsed.questions.length === 0
    ) {
      throw new Error("AI did not return a valid question list.");
    }

    const questions = parsed.questions
      .slice(0, numberOfQuestions)
      .map((question, index) =>
        normalizeQuestion(question, index, {
          difficulty,
          marks: marksPerQuestion,
          source: "ai",
        }),
      );

    // Validate questions.
    for (const question of questions) {
      if (!question.question) {
        throw new Error("AI generated an empty question.");
      }

      if (question.options.some((option) => !option)) {
        throw new Error("AI generated a question with an empty option.");
      }
    }

    const totalMarks = questions.reduce(
      (total, question) => total + Number(question.marks || marksPerQuestion),
      0,
    );

    return res.json({
      success: true,

      totalQuestions: questions.length,

      marksPerQuestion,

      totalMarks,

      difficulty,

      timeLimit,

      questions,
    });
  } catch (error) {
    console.error("GENERATE QUIZ ERROR:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Something went wrong while generating the quiz.",
    });
  }
});

// ============================================================
// REGENERATE QUESTION
// POST /regenerate-question
// ============================================================

app.post("/regenerate-question", async (req, res) => {
  try {
    const difficulty = ["easy", "moderate", "hard"].includes(
      String(req.body.difficulty || "").toLowerCase(),
    )
      ? String(req.body.difficulty).toLowerCase()
      : "moderate";

    const previousQuestion = cleanText(req.body.previousQuestion);

    if (!previousQuestion) {
      return res.status(400).json({
        success: false,
        error: "Previous question is required.",
      });
    }

    const prompt = `
Generate ONE new college-level multiple-choice question.

Difficulty: ${difficulty}

Previous question:
"${previousQuestion}"

Requirements:

- The new question must be different from the previous question.
- Exactly 4 options.
- Exactly one correct answer.
- correctAnswer must be zero-based.
- Include an explanation.
- Do not repeat the previous question.
- Return ONLY valid JSON.
- No markdown.
- No code fences.

Return exactly:

{
  "question": "Question text",
  "options": [
    "Option A",
    "Option B",
    "Option C",
    "Option D"
  ],
  "correctAnswer": 0,
  "explanation": "Explanation",
  "difficulty": "${difficulty}"
}
`;

    const aiText = await askGemini(prompt);

    const parsed = extractJson(aiText);

    const question = normalizeQuestion(parsed, 0, {
      difficulty,
      source: "ai",
      marks: 1,
    });

    if (!question.question) {
      throw new Error("AI generated an empty question.");
    }

    if (question.options.some((option) => !option)) {
      throw new Error("AI generated an invalid question.");
    }

    return res.json({
      success: true,

      question: {
        question: question.question,

        options: question.options,

        correctAnswer: question.correctAnswer,

        explanation: question.explanation,

        difficulty: question.difficulty,
      },
    });
  } catch (error) {
    console.error("REGENERATE QUESTION ERROR:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to regenerate question.",
    });
  }
});

// ============================================================
// PUBLISH QUIZ
// POST /publish-quiz
// ============================================================

app.post("/publish-quiz", async (req, res) => {
  try {
    const incomingQuiz = req.body.quiz;

    if (!incomingQuiz) {
      return res.status(400).json({
        success: false,
        error: "Quiz data is required.",
      });
    }

    if (
      !Array.isArray(incomingQuiz.questions) ||
      incomingQuiz.questions.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: "At least one question is required.",
      });
    }

    const activeQuestions = incomingQuiz.questions
      .filter((question) => !question.excluded)
      .map((question, index) =>
        normalizeQuestion(question, index, {
          marks: incomingQuiz.marksPerQuestion || 1,
          difficulty: incomingQuiz.difficulty || "moderate",
        }),
      );

    if (activeQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one active question is required.",
      });
    }

    const timeLimit = clampNumber(
      incomingQuiz.timeLimit,
      1,
      MAX_QUIZ_TIME,
      DEFAULT_QUIZ_TIME,
    );

    const totalMarks = activeQuestions.reduce(
      (total, question) => total + Number(question.marks || 1),
      0,
    );

    const code = await createUniqueQuizCode();

    const quiz = {
      code,

      title: incomingQuiz.title || "Advance's Quiz",

      totalQuestions: activeQuestions.length,

      marksPerQuestion: incomingQuiz.marksPerQuestion || 0,

      totalMarks,

      difficulty: incomingQuiz.difficulty || "mixed",

      timeLimit,

      questions: activeQuestions,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),

      publishedAt: admin.firestore.FieldValue.serverTimestamp(),

      status: "published",

      studentCount: 0,
    };

    await db.collection("quizzes").doc(code).set(quiz);

    console.log(`QUIZ PUBLISHED: ${code}`);

    return res.json({
      success: true,

      code,

      quiz: {
        code,

        totalQuestions: activeQuestions.length,

        totalMarks,

        timeLimit,
      },
    });
  } catch (error) {
    console.error("PUBLISH QUIZ ERROR:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to publish quiz.",
    });
  }
});

// ============================================================
// GET QUIZ
// GET /quiz/:code
//
// IMPORTANT:
// Correct answers are NEVER sent to students.
// ============================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

    const quizSnapshot = await db.collection("quizzes").doc(code).get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = {
      id: quizSnapshot.id,
      ...quizSnapshot.data(),
    };

    if (quiz.status !== "published") {
      return res.status(404).json({
        success: false,
        error: "This quiz is not available.",
      });
    }

    const studentQuiz = sanitizeQuizForStudent(quiz);

    return res.json({
      success: true,
      quiz: studentQuiz,
    });
  } catch (error) {
    console.error("GET QUIZ ERROR:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: "Failed to load quiz.",
    });
  }
});

// ============================================================
// STUDENT COUNT
// GET /quiz/:code/student-count
// ============================================================

app.get("/quiz/:code/student-count", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const studentsSnapshot = await quizRef.collection("students").get();

    return res.json({
      success: true,

      totalStudents: studentsSnapshot.size,
    });
  } catch (error) {
    console.error("STUDENT COUNT ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch student count.",
    });
  }
});

// ============================================================
// JOIN QUIZ
// POST /quiz/:code/join
// ============================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const studentName = cleanText(req.body.studentName);

    const enrollment = normalizeEnrollment(req.body.enrollment);

    if (!studentName) {
      return res.status(400).json({
        success: false,
        error: "Student name is required.",
      });
    }

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    if (quiz.status !== "published") {
      return res.status(400).json({
        success: false,
        error: "Quiz is not active.",
      });
    }

    // --------------------------------------------------------
    // STUDENT DOCUMENT
    // --------------------------------------------------------

    const studentRef = quizRef.collection("students").doc(enrollment);

    const existingSnapshot = await studentRef.get();

    const now = new Date();

    // --------------------------------------------------------
    // IF ALREADY JOINED
    // --------------------------------------------------------

    if (existingSnapshot.exists) {
      const existing = existingSnapshot.data();

      if (existing.submitted) {
        return res.status(409).json({
          success: false,
          error: "This enrollment number has already submitted this quiz.",
        });
      }

      const existingExpiry = safeDate(existing.expiresAt);

      if (existingExpiry && existingExpiry.getTime() > now.getTime()) {
        return res.json({
          success: true,

          message: "Student already joined this quiz.",

          student: {
            studentName: existing.studentName,

            enrollment: existing.enrollment,

            joinedAt: serializeTimestamp(existing.joinedAt),

            expiresAt: serializeTimestamp(existing.expiresAt),
          },
        });
      }

      // Existing attempt expired.
      // Create a fresh attempt.
    }

    // --------------------------------------------------------
    // SERVER-CONTROLLED EXPIRATION
    // --------------------------------------------------------

    const timeLimit = clampNumber(
      quiz.timeLimit,
      1,
      MAX_QUIZ_TIME,
      DEFAULT_QUIZ_TIME,
    );

    const expiresAt = new Date(now.getTime() + timeLimit * 60 * 1000);

    const studentData = {
      studentName,

      enrollment,

      quizCode: code,

      joinedAt: admin.firestore.Timestamp.fromDate(now),

      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),

      submitted: false,

      submittedAt: null,

      score: null,

      totalMarks: Number(quiz.totalMarks || 0),

      percentage: null,
    };

    await studentRef.set(studentData);

    console.log(`STUDENT JOINED: ${studentName} | ${enrollment} | ${code}`);

    return res.json({
      success: true,

      message: "Quiz joined successfully.",

      student: {
        studentName,

        enrollment,

        joinedAt: now.toISOString(),

        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("JOIN QUIZ ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to join quiz.",
    });
  }
});

// ============================================================
// SUBMIT QUIZ
// POST /quiz/:code/submit
// ============================================================

app.post("/quiz/:code/submit", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const enrollment = normalizeEnrollment(req.body.enrollment);

    const answers = req.body.answers || {};

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    const studentRef = quizRef.collection("students").doc(enrollment);

    const studentSnapshot = await studentRef.get();

    if (!studentSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Student attempt not found. Please join the quiz first.",
      });
    }

    const student = studentSnapshot.data();

    // --------------------------------------------------------
    // PREVENT DOUBLE SUBMISSION
    // --------------------------------------------------------

    if (student.submitted) {
      return res.status(409).json({
        success: false,
        error: "This quiz has already been submitted.",
      });
    }

    // --------------------------------------------------------
    // CHECK SERVER EXPIRATION
    // --------------------------------------------------------

    const expiresAt = safeDate(student.expiresAt);

    const now = new Date();

    if (!expiresAt || now.getTime() > expiresAt.getTime()) {
      return res.status(408).json({
        success: false,
        error: "Quiz time has expired. The submission was not accepted.",
      });
    }

    // --------------------------------------------------------
    // CALCULATE SCORE ON SERVER
    // --------------------------------------------------------

    let score = 0;

    let totalMarks = 0;

    const review = [];

    quiz.questions.forEach((question, index) => {
      const marks = Number(question.marks || quiz.marksPerQuestion || 1);

      totalMarks += marks;

      const studentAnswer = Object.prototype.hasOwnProperty.call(answers, index)
        ? Number(answers[index])
        : null;

      const correctAnswer = Number(question.correctAnswer);

      const isCorrect =
        Number.isInteger(studentAnswer) && studentAnswer === correctAnswer;

      if (isCorrect) {
        score += marks;
      }

      review.push({
        question: question.question,

        options: question.options,

        correctAnswer,

        studentAnswer,

        explanation: question.explanation || "",

        marks,

        isCorrect,
      });
    });

    const percentage =
      totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(2)) : 0;

    // --------------------------------------------------------
    // SAVE RESULT
    // --------------------------------------------------------

    await studentRef.update({
      submitted: true,

      submittedAt: admin.firestore.FieldValue.serverTimestamp(),

      score,

      totalMarks,

      percentage,
    });

    console.log(
      `QUIZ SUBMITTED: ${enrollment} | ${code} | ${score}/${totalMarks}`,
    );

    return res.json({
      success: true,

      result: {
        score,

        totalMarks,

        percentage,

        review,
      },
    });
  } catch (error) {
    console.error("SUBMIT QUIZ ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to submit quiz.",
    });
  }
});

// ============================================================
// MULTER / GENERAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: "PDF is too large. Maximum size is 20 MB.",
      });
    }

    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }

  if (error && error.message === "Only PDF files are allowed.") {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }

  return res.status(500).json({
    success: false,
    error: error.message || "Internal server error.",
  });
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("==============================================");
  console.log("       ADVANCE'S QUIZ SERVER");
  console.log("==============================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: /health`);
  console.log("Firebase: Firestore");
  console.log(
    `Gemini: ${process.env.GEMINI_API_KEY ? "configured" : "MISSING"}`,
  );
  console.log("==============================================");
  console.log("");
});

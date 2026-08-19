const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

require("dotenv").config();

// ============================================================
// APP CONFIGURATION
// ============================================================

const app = express();

const PORT = process.env.PORT || 5000;

const FRONTEND_URL = process.env.FRONTEND_URL || "*";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DEFAULT_TIME_LIMIT = 30;

const MAX_TIME_LIMIT = 180;

const MIN_TIME_LIMIT = 1;

// ============================================================
// GEMINI
// ============================================================

if (!GEMINI_API_KEY) {
  console.warn(
    "WARNING: GEMINI_API_KEY is not configured in environment variables.",
  );
}

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Change this if your account uses another Gemini model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: FRONTEND_URL === "*" ? "*" : FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  }),
);

// ============================================================
// UPLOAD CONFIGURATION
// ============================================================

const uploadDirectory = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, {
    recursive: true,
  });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDirectory);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() + "-" + crypto.randomBytes(6).toString("hex") + ".pdf";

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024,
  },

  fileFilter: function (req, file, cb) {
    const isPDF =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPDF) {
      return cb(new Error("Only PDF files are allowed."));
    }

    cb(null, true);
  },
});

// ============================================================
// IN-MEMORY DATABASE
// ============================================================
//
// IMPORTANT:
//
// This database is temporary.
//
// On Render's free/server restart, all quizzes disappear.
//
// For production, replace this with MongoDB/PostgreSQL.
//
// ============================================================

const quizzes = new Map();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function generateQuizCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
  } while (quizzes.has(code));

  return code;
}

// ------------------------------------------------------------

function clampTimeLimit(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_TIME_LIMIT;
  }

  return Math.min(
    MAX_TIME_LIMIT,
    Math.max(MIN_TIME_LIMIT, Math.round(numericValue)),
  );
}

// ------------------------------------------------------------

function cleanEnrollment(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

// ------------------------------------------------------------

function cleanStudentName(value) {
  return String(value || "").trim();
}

// ------------------------------------------------------------

function normalizeCorrectAnswer(value) {
  const numeric = Number(value);

  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 3) {
    return numeric;
  }

  if (typeof value === "string") {
    const answer = value.trim().toUpperCase();

    if (["A", "B", "C", "D"].includes(answer)) {
      return answer.charCodeAt(0) - 65;
    }
  }

  return 0;
}

// ------------------------------------------------------------

function normalizeDifficulty(value) {
  const difficulty = String(value || "moderate")
    .trim()
    .toLowerCase();

  if (["easy", "moderate", "hard"].includes(difficulty)) {
    return difficulty;
  }

  return "moderate";
}

// ------------------------------------------------------------

function sanitizeQuestion(question, fallbackDifficulty = "moderate") {
  return {
    question: String(question?.question || "").trim(),

    options: Array.isArray(question?.options)
      ? question.options
          .slice(0, 4)
          .map((option) => String(option || "").trim())
      : [],

    correctAnswer: normalizeCorrectAnswer(question?.correctAnswer),

    explanation: String(question?.explanation || "").trim(),

    difficulty: normalizeDifficulty(question?.difficulty || fallbackDifficulty),

    marks: Number(question?.marks) || 1,
  };
}

// ------------------------------------------------------------

function isValidQuestion(question) {
  if (!question) {
    return false;
  }

  if (!question.question) {
    return false;
  }

  if (!Array.isArray(question.options)) {
    return false;
  }

  if (question.options.length !== 4) {
    return false;
  }

  if (
    !Number.isInteger(question.correctAnswer) ||
    question.correctAnswer < 0 ||
    question.correctAnswer > 3
  ) {
    return false;
  }

  return question.options.every((option) => String(option).trim().length > 0);
}

// ------------------------------------------------------------

function calculateTotalMarks(questions) {
  return questions.reduce((total, question) => {
    return total + Number(question.marks || 1);
  }, 0);
}

// ------------------------------------------------------------

function getRemainingSeconds(expiresAt) {
  return Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
}

// ------------------------------------------------------------

function quizIsExpired(quiz) {
  if (!quiz) {
    return true;
  }

  return Date.now() >= quiz.expiresAt;
}

// ============================================================
// GEMINI HELPER
// ============================================================

async function generateWithGemini(prompt) {
  if (!genAI) {
    throw new Error(
      "GEMINI_API_KEY is missing. Add GEMINI_API_KEY to your environment variables.",
    );
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
  });

  const result = await model.generateContent(prompt);

  const response = result.response;

  const text = response.text();

  return text;
}

// ============================================================
// JSON EXTRACTION
// ============================================================

function extractJSON(text) {
  if (!text) {
    throw new Error("AI returned an empty response.");
  }

  let cleaned = text.trim();

  // Remove markdown code blocks.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Try direct JSON.
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Continue below.
  }

  // Find JSON array.
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd !== -1) {
    const possibleArray = cleaned.slice(arrayStart, arrayEnd + 1);

    try {
      return JSON.parse(possibleArray);
    } catch (error) {
      // Continue below.
    }
  }

  // Find JSON object.
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd !== -1) {
    const possibleObject = cleaned.slice(objectStart, objectEnd + 1);

    try {
      return JSON.parse(possibleObject);
    } catch (error) {
      // Continue below.
    }
  }

  throw new Error("AI returned invalid JSON.");
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Advance's Quiz API is running.",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// SERVER STATUS
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    activeQuizzes: quizzes.size,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// GENERATE QUIZ FROM PDF
// ============================================================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  let uploadedFile = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a PDF file.",
      });
    }

    uploadedFile = req.file.path;

    const numberOfQuestions = Math.min(
      50,
      Math.max(1, Number(req.body.numberOfQuestions) || 10),
    );

    const marksPerQuestion = Math.min(
      20,
      Math.max(1, Number(req.body.marksPerQuestion) || 2),
    );

    const difficulty = normalizeDifficulty(req.body.difficulty);

    const timeLimit = clampTimeLimit(req.body.timeLimit);

    console.log("GENERATING QUIZ:", {
      numberOfQuestions,
      marksPerQuestion,
      difficulty,
      timeLimit,
    });

    // --------------------------------------------------------
    // READ PDF
    // --------------------------------------------------------

    const pdfBuffer = fs.readFileSync(uploadedFile);

    const pdfData = await pdfParse(pdfBuffer);

    const extractedText = String(pdfData.text || "").trim();

    if (!extractedText) {
      throw new Error("Could not extract readable text from the PDF.");
    }

    // Prevent gigantic prompts.
    const MAX_TEXT_LENGTH = 100000;

    const studyMaterial =
      extractedText.length > MAX_TEXT_LENGTH
        ? extractedText.slice(0, MAX_TEXT_LENGTH)
        : extractedText;

    // --------------------------------------------------------
    // AI PROMPT
    // --------------------------------------------------------

    const prompt = `
You are an expert college-level examination question generator.

Create exactly ${numberOfQuestions} multiple-choice questions from the study material below.

Difficulty:
${difficulty}

Each question carries:
${marksPerQuestion} marks.

IMPORTANT RULES:

1. Questions MUST be based only on the supplied study material.
2. Do not invent facts.
3. Do not repeat questions.
4. Every question must have exactly FOUR options.
5. Exactly ONE option must be correct.
6. Make distractors plausible.
7. Avoid ambiguous questions.
8. Avoid "all of the above".
9. Avoid "none of the above".
10. Include a concise explanation.
11. Use difficulty "${difficulty}".
12. Return ONLY valid JSON.
13. Do NOT use markdown.
14. Do NOT add any text before or after the JSON.

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
      "explanation": "Why this answer is correct.",
      "difficulty": "${difficulty}",
      "marks": ${marksPerQuestion}
    }
  ]
}

correctAnswer must be:
0 for A
1 for B
2 for C
3 for D

STUDY MATERIAL:

${studyMaterial}
`;

    // --------------------------------------------------------
    // CALL GEMINI
    // --------------------------------------------------------

    const aiText = await generateWithGemini(prompt);

    const parsed = extractJSON(aiText);

    const rawQuestions = Array.isArray(parsed) ? parsed : parsed.questions;

    if (!Array.isArray(rawQuestions)) {
      throw new Error("AI response does not contain a questions array.");
    }

    // --------------------------------------------------------
    // SANITIZE QUESTIONS
    // --------------------------------------------------------

    const questions = rawQuestions
      .map((question) => sanitizeQuestion(question, difficulty))
      .filter(isValidQuestion)
      .slice(0, numberOfQuestions)
      .map((question, index) => ({
        ...question,

        id: index + 1,

        marks: marksPerQuestion,

        excluded: false,

        source: "ai",
      }));

    if (questions.length === 0) {
      throw new Error("AI did not generate any valid questions.");
    }

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    res.json({
      success: true,

      totalQuestions: questions.length,

      marksPerQuestion,

      totalMarks: questions.length * marksPerQuestion,

      difficulty,

      timeLimit,

      questions,
    });
  } catch (error) {
    console.error("GENERATE QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to generate quiz.",
    });
  } finally {
    // --------------------------------------------------------
    // DELETE TEMPORARY PDF
    // --------------------------------------------------------

    if (uploadedFile && fs.existsSync(uploadedFile)) {
      try {
        fs.unlinkSync(uploadedFile);
      } catch (error) {
        console.error("PDF CLEANUP ERROR:", error);
      }
    }
  }
});

// ============================================================
// REGENERATE SINGLE QUESTION
// ============================================================

app.post("/regenerate-question", async (req, res) => {
  try {
    const { difficulty, previousQuestion } = req.body;

    if (!previousQuestion) {
      return res.status(400).json({
        success: false,
        error: "Previous question is required.",
      });
    }

    const cleanDifficulty = normalizeDifficulty(difficulty);

    const prompt = `
You are an expert college-level MCQ generator.

Generate ONE replacement multiple-choice question.

Difficulty:
${cleanDifficulty}

The new question MUST be different from this previous question:

"${previousQuestion}"

Rules:

1. Generate exactly FOUR options.
2. Exactly ONE option is correct.
3. Make the question conceptually different.
4. Keep the difficulty at ${cleanDifficulty}.
5. Include an explanation.
6. Do not use "all of the above".
7. Do not use "none of the above".
8. Return ONLY valid JSON.
9. Do not use markdown.

Return:

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
  "difficulty": "${cleanDifficulty}"
}

correctAnswer:
0 = A
1 = B
2 = C
3 = D
`;

    const aiText = await generateWithGemini(prompt);

    const parsed = extractJSON(aiText);

    const newQuestion = sanitizeQuestion(
      parsed.question ? parsed : parsed.questions?.[0],
      cleanDifficulty,
    );

    if (!isValidQuestion(newQuestion)) {
      throw new Error("AI returned an invalid replacement question.");
    }

    res.json({
      success: true,
      question: newQuestion,
    });
  } catch (error) {
    console.error("REGENERATE QUESTION ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to regenerate question.",
    });
  }
});

// ============================================================
// PUBLISH QUIZ
// ============================================================

app.post("/publish-quiz", async (req, res) => {
  try {
    const incomingQuiz = req.body?.quiz;

    if (!incomingQuiz) {
      return res.status(400).json({
        success: false,
        error: "Quiz data is required.",
      });
    }

    if (!Array.isArray(incomingQuiz.questions)) {
      return res.status(400).json({
        success: false,
        error: "Quiz must contain questions.",
      });
    }

    // --------------------------------------------------------
    // ONLY ACTIVE QUESTIONS
    // --------------------------------------------------------

    const activeQuestions = incomingQuiz.questions
      .filter((question) => !question.excluded)
      .map((question, index) => ({
        ...question,

        id: index + 1,

        excluded: false,

        correctAnswer: normalizeCorrectAnswer(question.correctAnswer),

        difficulty: normalizeDifficulty(question.difficulty),

        marks:
          Number(question.marks) || Number(incomingQuiz.marksPerQuestion) || 1,
      }))
      .filter(isValidQuestion);

    if (activeQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one valid question is required.",
      });
    }

    // --------------------------------------------------------
    // TIMER
    // --------------------------------------------------------

    const timeLimit = clampTimeLimit(incomingQuiz.timeLimit);

    // --------------------------------------------------------
    // QUIZ CODE
    // --------------------------------------------------------

    const code = generateQuizCode();

    const now = Date.now();

    // This is the maximum lifetime of the quiz itself.
    // Students receive their own expiration time when joining.
    const quiz = {
      id: crypto.randomUUID(),

      code,

      title: incomingQuiz.title || "Advance's Quiz",

      difficulty: incomingQuiz.difficulty || "mixed",

      marksPerQuestion: Number(incomingQuiz.marksPerQuestion) || 0,

      timeLimit,

      questions: activeQuestions,

      totalQuestions: activeQuestions.length,

      totalMarks: calculateTotalMarks(activeQuestions),

      createdAt: new Date(now).toISOString(),

      createdAtMs: now,

      students: new Map(),

      published: true,
    };

    quizzes.set(code, quiz);

    console.log("QUIZ PUBLISHED:", {
      code,
      timeLimit,
      questions: activeQuestions.length,
    });

    res.json({
      success: true,

      code,

      quiz: {
        code,
        title: quiz.title,
        difficulty: quiz.difficulty,
        timeLimit: quiz.timeLimit,
        totalQuestions: quiz.totalQuestions,
        totalMarks: quiz.totalMarks,
      },
    });
  } catch (error) {
    console.error("PUBLISH QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to publish quiz.",
    });
  }
});

// ============================================================
// JOIN QUIZ
// ============================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();

    const studentName = cleanStudentName(req.body?.studentName);

    const enrollment = cleanEnrollment(req.body?.enrollment);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

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

    const quiz = quizzes.get(code);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found. Please check the quiz code.",
      });
    }

    // --------------------------------------------------------
    // CHECK WHETHER QUIZ IS STILL AVAILABLE
    // --------------------------------------------------------

    if (quiz.closed) {
      return res.status(410).json({
        success: false,
        error: "This quiz is closed.",
      });
    }

    // --------------------------------------------------------
    // DUPLICATE ENROLLMENT
    // --------------------------------------------------------

    const existingStudent = quiz.students.get(enrollment);

    if (existingStudent && existingStudent.submitted) {
      return res.status(409).json({
        success: false,
        error: "This enrollment number has already submitted the quiz.",
      });
    }

    // --------------------------------------------------------
    // CREATE / RESTORE ATTEMPT
    // --------------------------------------------------------

    let student = existingStudent;

    if (!student) {
      const joinedAtMs = Date.now();

      const expiresAtMs = joinedAtMs + quiz.timeLimit * 60 * 1000;

      student = {
        id: crypto.randomUUID(),

        studentName,

        enrollment,

        joinedAt: new Date(joinedAtMs).toISOString(),

        joinedAtMs,

        expiresAt: new Date(expiresAtMs).toISOString(),

        expiresAtMs,

        submitted: false,

        submittedAt: null,

        answers: {},

        result: null,
      };

      quiz.students.set(enrollment, student);
    } else {
      // Student refresh/reconnect.
      //
      // Keep original expiration time.
      student.studentName = studentName;
    }

    // --------------------------------------------------------
    // IF EXISTING ATTEMPT EXPIRED
    // --------------------------------------------------------

    if (!student.submitted && Date.now() >= student.expiresAtMs) {
      return res.status(410).json({
        success: false,
        error: "Your quiz attempt has expired.",
      });
    }

    const remainingSeconds = getRemainingSeconds(student.expiresAt);

    console.log("STUDENT JOINED:", {
      code,
      enrollment,
      studentName,
      remainingSeconds,
    });

    res.json({
      success: true,

      student: {
        id: student.id,

        studentName: student.studentName,

        enrollment: student.enrollment,

        joinedAt: student.joinedAt,

        expiresAt: student.expiresAt,

        remainingSeconds,
      },
    });
  } catch (error) {
    console.error("JOIN QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to join quiz.",
    });
  }
});

// ============================================================
// GET QUIZ FOR STUDENT
// ============================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();

    const quiz = quizzes.get(code);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    if (quiz.closed) {
      return res.status(410).json({
        success: false,
        error: "This quiz is closed.",
      });
    }

    // --------------------------------------------------------
    // IMPORTANT SECURITY:
    //
    // Do NOT send correctAnswer to students.
    //
    // --------------------------------------------------------

    const studentQuestions = quiz.questions.map((question) => ({
      id: question.id,

      question: question.question,

      options: question.options,

      marks: question.marks,

      difficulty: question.difficulty,
    }));

    res.json({
      success: true,

      quiz: {
        code: quiz.code,

        title: quiz.title,

        difficulty: quiz.difficulty,

        timeLimit: quiz.timeLimit,

        totalQuestions: quiz.totalQuestions,

        totalMarks: quiz.totalMarks,

        questions: studentQuestions,
      },
    });
  } catch (error) {
    console.error("GET QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to load quiz.",
    });
  }
});

// ============================================================
// STUDENT COUNT
// ============================================================

app.get("/quiz/:code/student-count", async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();

    const quiz = quizzes.get(code);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const totalStudents = quiz.students.size;

    res.json({
      success: true,

      totalStudents,
    });
  } catch (error) {
    console.error("STUDENT COUNT ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to get student count.",
    });
  }
});

// ============================================================
// SUBMIT QUIZ
// ============================================================

app.post("/quiz/:code/submit", async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();

    const enrollment = cleanEnrollment(req.body?.enrollment);

    const answers = req.body?.answers || {};

    // --------------------------------------------------------
    // VALIDATE
    // --------------------------------------------------------

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Quiz code is required.",
      });
    }

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const quiz = quizzes.get(code);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const student = quiz.students.get(enrollment);

    if (!student) {
      return res.status(404).json({
        success: false,
        error: "Student attempt not found. Please join the quiz first.",
      });
    }

    // --------------------------------------------------------
    // ALREADY SUBMITTED
    // --------------------------------------------------------

    if (student.submitted) {
      return res.status(409).json({
        success: false,
        error: "This quiz has already been submitted.",
        result: student.result,
      });
    }

    // --------------------------------------------------------
    // SERVER TIMER CHECK
    // --------------------------------------------------------

    const expired = Date.now() >= student.expiresAtMs;

    // --------------------------------------------------------
    // CALCULATE RESULT
    // --------------------------------------------------------

    let score = 0;

    let totalMarks = 0;

    const review = [];

    for (let index = 0; index < quiz.questions.length; index++) {
      const question = quiz.questions[index];

      const marks = Number(question.marks) || 1;

      totalMarks += marks;

      // Answers are keyed by question index
      // because that is what your React frontend sends.
      const rawStudentAnswer = answers[index];

      const studentAnswer =
        rawStudentAnswer === undefined || rawStudentAnswer === null
          ? null
          : Number(rawStudentAnswer);

      const isCorrect =
        studentAnswer !== null &&
        Number.isInteger(studentAnswer) &&
        studentAnswer === Number(question.correctAnswer);

      if (isCorrect) {
        score += marks;
      }

      review.push({
        question: question.question,

        options: question.options,

        correctAnswer: question.correctAnswer,

        studentAnswer,

        isCorrect,

        marks,

        explanation: question.explanation || "",
      });
    }

    const percentage =
      totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(2)) : 0;

    // --------------------------------------------------------
    // SAVE RESULT
    // --------------------------------------------------------

    const result = {
      score,

      totalMarks,

      percentage,

      submittedAt: new Date().toISOString(),

      autoSubmitted: expired,

      review,
    };

    student.submitted = true;

    student.submittedAt = result.submittedAt;

    student.answers = answers;

    student.result = result;

    console.log("QUIZ SUBMITTED:", {
      code,
      enrollment,
      score,
      totalMarks,
      percentage,
      autoSubmitted: expired,
    });

    res.json({
      success: true,

      result,
    });
  } catch (error) {
    console.error("SUBMIT QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to submit quiz.",
    });
  }
});

// ============================================================
// OPTIONAL: GET QUIZ STATUS
// ============================================================

app.get("/quiz/:code/status", async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();

    const quiz = quizzes.get(code);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    res.json({
      success: true,

      code: quiz.code,

      title: quiz.title,

      published: quiz.published,

      closed: Boolean(quiz.closed),

      totalStudents: quiz.students.size,

      totalQuestions: quiz.totalQuestions,

      totalMarks: quiz.totalMarks,

      timeLimit: quiz.timeLimit,

      createdAt: quiz.createdAt,
    });
  } catch (error) {
    console.error("QUIZ STATUS ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to get quiz status.",
    });
  }
});

// ============================================================
// ERROR HANDLER - MULTER
// ============================================================

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: error.message || "File upload error.",
    });
  }

  if (error && error.message === "Only PDF files are allowed.") {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }

  next(error);
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("UNHANDLED SERVER ERROR:", error);

  res.status(500).json({
    success: false,
    error: error.message || "Internal server error.",
  });
});

// ============================================================
// CLEANUP EXPIRED QUIZZES
// ============================================================
//
// We don't immediately delete published quizzes because
// teachers may still want to see the live screen.
//
// Instead, quizzes older than 24 hours are removed.
//
// ============================================================

const CLEANUP_INTERVAL = 10 * 60 * 1000;

const QUIZ_MAX_AGE = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [code, quiz] of quizzes.entries()) {
    if (now - quiz.createdAtMs > QUIZ_MAX_AGE) {
      quizzes.delete(code);

      console.log("CLEANED EXPIRED QUIZ:", code);
    }
  }
}, CLEANUP_INTERVAL);

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("       ADVANCE'S QUIZ SERVER");
  console.log("========================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Default quiz time: ${DEFAULT_TIME_LIMIT} minutes`);
  console.log("========================================");
  console.log("");
});

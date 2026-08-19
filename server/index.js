// ============================================================
// ADVANCE'S QUIZ - COMPLETE BACKEND
// Compatible with the exact App.js provided
// ============================================================

// ============================================================
// IMPORTS
// ============================================================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mongoose = require("mongoose");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

require("dotenv").config();

// ============================================================
// APP
// ============================================================

const app = express();

// Render provides PORT automatically.
// Locally it falls back to 10000.
const PORT = process.env.PORT || 10000;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================================================
// MULTER
// ============================================================

// PDF stays in memory.
// We don't need to permanently save uploaded PDFs.
const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },

  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return cb(new Error("Only PDF files are allowed."));
    }

    cb(null, true);
  },
});

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ============================================================
// GEMINI
// ============================================================

let gemini = null;
let model = null;

if (GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(GEMINI_API_KEY);

  model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
  });

  console.log(`Gemini configured: ${GEMINI_MODEL}`);
} else {
  console.warn(
    "WARNING: GEMINI_API_KEY is missing. AI generation will not work.",
  );
}

// ============================================================
// MONGODB SCHEMA
// ============================================================

const studentSchema = new mongoose.Schema(
  {
    studentName: {
      type: String,
      required: true,
      trim: true,
    },

    enrollment: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    joinedAt: {
      type: Date,
      default: Date.now,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    submitted: {
      type: Boolean,
      default: false,
    },

    answers: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    _id: true,
  },
);

const questionSchema = new mongoose.Schema(
  {
    id: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    question: {
      type: String,
      required: true,
    },

    options: {
      type: [String],
      required: true,
    },

    correctAnswer: {
      type: Number,
      required: true,
    },

    explanation: {
      type: String,
      default: "",
    },

    difficulty: {
      type: String,
      default: "moderate",
    },

    marks: {
      type: Number,
      default: 1,
    },

    excluded: {
      type: Boolean,
      default: false,
    },

    source: {
      type: String,
      enum: ["ai", "manual"],
      default: "ai",
    },
  },
  {
    _id: false,
  },
);

const quizSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    title: {
      type: String,
      default: "Advance's Quiz",
    },

    success: {
      type: Boolean,
      default: true,
    },

    totalQuestions: {
      type: Number,
      default: 0,
    },

    marksPerQuestion: {
      type: Number,
      default: 0,
    },

    totalMarks: {
      type: Number,
      default: 0,
    },

    difficulty: {
      type: String,
      default: "moderate",
    },

    timeLimit: {
      type: Number,
      default: 30,
      min: 1,
      max: 180,
    },

    questions: {
      type: [questionSchema],
      default: [],
    },

    publishedAt: {
      type: Date,
      default: Date.now,
    },

    students: {
      type: [studentSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

const Quiz = mongoose.model("Quiz", quizSchema);

// ============================================================
// DATABASE CONNECTION
// ============================================================

let databaseReady = false;

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.warn(
      "WARNING: MONGODB_URI is missing. MongoDB persistence is disabled.",
    );

    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);

    databaseReady = true;

    console.log("MongoDB connected successfully.");
  } catch (error) {
    console.error("MongoDB connection failed:");
    console.error(error.message);
  }
}

// ============================================================
// UTILITY - NORMALIZE TEXT
// ============================================================

function cleanText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

// ============================================================
// UTILITY - GENERATE QUIZ CODE
// ============================================================

async function generateQuizCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";

    for (let i = 0; i < 6; i++) {
      const index = crypto.randomInt(0, characters.length);

      code += characters[index];
    }

    const existingQuiz = await Quiz.findOne({ code }).lean();

    if (!existingQuiz) {
      return code;
    }
  }

  throw new Error("Unable to generate a unique quiz code.");
}

// ============================================================
// UTILITY - EXTRACT JSON FROM AI RESPONSE
// ============================================================

function extractJson(text) {
  let cleaned = cleanText(text);

  // Remove Markdown code fences.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Try direct JSON.
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Continue.
  }

  // Find first JSON object.
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd !== -1) {
    const objectText = cleaned.slice(objectStart, objectEnd + 1);

    try {
      return JSON.parse(objectText);
    } catch (error) {
      // Continue.
    }
  }

  // Find first JSON array.
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd !== -1) {
    const arrayText = cleaned.slice(arrayStart, arrayEnd + 1);

    try {
      return JSON.parse(arrayText);
    } catch (error) {
      // Continue.
    }
  }

  throw new Error("AI returned invalid JSON.");
}

// ============================================================
// UTILITY - NORMALIZE QUESTION
// ============================================================

function normalizeQuestion(
  question,
  index = 0,
  fallbackDifficulty = "moderate",
) {
  if (!question) {
    throw new Error(`Question ${index + 1} is empty.`);
  }

  const options = Array.isArray(question.options)
    ? question.options.map((option) => cleanText(option))
    : [];

  if (options.length !== 4) {
    throw new Error(`Question ${index + 1} must contain exactly four options.`);
  }

  let correctAnswer = Number(question.correctAnswer);

  // Support AI returning A/B/C/D.
  if (
    typeof question.correctAnswer === "string" &&
    /^[ABCD]$/i.test(question.correctAnswer.trim())
  ) {
    correctAnswer =
      question.correctAnswer.trim().toUpperCase().charCodeAt(0) - 65;
  }

  if (
    !Number.isInteger(correctAnswer) ||
    correctAnswer < 0 ||
    correctAnswer > 3
  ) {
    throw new Error(`Question ${index + 1} has an invalid correctAnswer.`);
  }

  const difficulty = ["easy", "moderate", "hard"].includes(
    String(question.difficulty || "").toLowerCase(),
  )
    ? String(question.difficulty).toLowerCase()
    : fallbackDifficulty;

  return {
    id:
      question.id !== undefined && question.id !== null
        ? question.id
        : index + 1,

    question: cleanText(question.question),

    options,

    correctAnswer,

    explanation: cleanText(question.explanation),

    difficulty,

    marks: Math.max(1, Number(question.marks) || 1),

    excluded: Boolean(question.excluded),

    source: question.source === "manual" ? "manual" : "ai",
  };
}

// ============================================================
// UTILITY - GET ACTIVE QUESTIONS
// ============================================================

function getActiveQuestions(quiz) {
  return (quiz.questions || []).filter((question) => !question.excluded);
}

// ============================================================
// UTILITY - TOTAL MARKS
// ============================================================

function calculateTotalMarks(questions) {
  return questions.reduce((total, question) => {
    return total + Number(question.marks || 0);
  }, 0);
}

// ============================================================
// UTILITY - FIND STUDENT
// ============================================================

function findStudent(quiz, enrollment) {
  const cleanEnrollment = cleanText(enrollment).toUpperCase();

  return quiz.students.find(
    (student) => String(student.enrollment).toUpperCase() === cleanEnrollment,
  );
}

// ============================================================
// UTILITY - BUILD RESULT
// ============================================================

function calculateResult(quiz, student) {
  const questions = quiz.questions || [];

  const answers = student.answers || {};

  let score = 0;

  let totalMarks = 0;

  const review = [];

  questions.forEach((question, index) => {
    const marks = Number(question.marks || 0);

    totalMarks += marks;

    const rawAnswer = answers[index];

    const studentAnswer =
      rawAnswer === undefined || rawAnswer === null || rawAnswer === ""
        ? null
        : Number(rawAnswer);

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

      correctAnswer: Number(question.correctAnswer),

      studentAnswer,

      isCorrect,

      explanation: question.explanation || "",
    });
  });

  const percentage =
    totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(2)) : 0;

  return {
    score,

    totalMarks,

    percentage,

    review,
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Advance's Quiz API is running.",
    database: databaseReady ? "connected" : "not connected",
    ai: model ? "configured" : "not configured",
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    database: databaseReady,
    ai: Boolean(model),
  });
});

// ============================================================
// GENERATE QUIZ WITH AI
// ============================================================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  try {
    if (!model) {
      return res.status(500).json({
        success: false,
        error:
          "Gemini API is not configured. Add GEMINI_API_KEY to the server environment variables.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a PDF file.",
      });
    }

    const numberOfQuestions = Math.min(
      50,
      Math.max(1, Number(req.body.numberOfQuestions) || 10),
    );

    const marksPerQuestion = Math.min(
      20,
      Math.max(1, Number(req.body.marksPerQuestion) || 2),
    );

    const difficulty = ["easy", "moderate", "hard"].includes(
      String(req.body.difficulty || "").toLowerCase(),
    )
      ? String(req.body.difficulty).toLowerCase()
      : "moderate";

    const timeLimit = Math.min(
      180,
      Math.max(1, Number(req.body.timeLimit) || 30),
    );

    console.log(`Generating ${numberOfQuestions} ${difficulty} questions...`);

    // ========================================================
    // EXTRACT PDF TEXT
    // ========================================================

    const pdfData = await pdfParse(req.file.buffer);

    const pdfText = cleanText(pdfData.text);

    if (!pdfText) {
      return res.status(400).json({
        success: false,
        error:
          "Could not extract text from this PDF. Please upload a text-based PDF.",
      });
    }

    // Protect AI request from extremely large PDFs.
    const MAX_TEXT_LENGTH = 90000;

    const studyMaterial =
      pdfText.length > MAX_TEXT_LENGTH
        ? pdfText.slice(0, MAX_TEXT_LENGTH)
        : pdfText;

    // ========================================================
    // GEMINI PROMPT
    // ========================================================

    const prompt = `
You are an expert college-level examination question generator.

Create exactly ${numberOfQuestions} multiple-choice questions from the study material below.

Requirements:

1. Every question MUST be based only on the supplied study material.
2. Difficulty must be "${difficulty}".
3. Each question must have exactly 4 options.
4. Only one option may be correct.
5. correctAnswer MUST be a zero-based integer:
   0 = option A
   1 = option B
   2 = option C
   3 = option D
6. Questions should test actual understanding, not random trivia.
7. Avoid duplicate or nearly duplicate questions.
8. Include a short explanation for every correct answer.
9. Use marks = ${marksPerQuestion}.
10. Return ONLY valid JSON.
11. Do not use Markdown.
12. Do not include any text before or after the JSON.

Return exactly this structure:

{
  "success": true,
  "title": "Advance's Quiz",
  "totalQuestions": ${numberOfQuestions},
  "marksPerQuestion": ${marksPerQuestion},
  "totalMarks": ${numberOfQuestions * marksPerQuestion},
  "difficulty": "${difficulty}",
  "questions": [
    {
      "id": 1,
      "question": "Question text",
      "options": [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      "correctAnswer": 0,
      "explanation": "Short explanation",
      "difficulty": "${difficulty}",
      "marks": ${marksPerQuestion}
    }
  ]
}

STUDY MATERIAL:

${studyMaterial}
`;

    // ========================================================
    // GEMINI REQUEST
    // ========================================================

    const result = await model.generateContent(prompt);

    const response = result.response;

    const text = response.text();

    const parsed = extractJson(text);

    if (!parsed || !Array.isArray(parsed.questions)) {
      throw new Error("AI did not return a valid questions array.");
    }

    // ========================================================
    // NORMALIZE QUESTIONS
    // ========================================================

    const questions = parsed.questions
      .slice(0, numberOfQuestions)
      .map((question, index) => normalizeQuestion(question, index, difficulty));

    if (questions.length === 0) {
      throw new Error("AI generated zero questions.");
    }

    // Make sure every question uses requested marks.
    questions.forEach((question) => {
      question.marks = marksPerQuestion;
      question.source = "ai";
      question.excluded = false;
    });

    // ========================================================
    // RESPONSE
    // ========================================================

    return res.json({
      success: true,

      title: parsed.title || "Advance's Quiz",

      totalQuestions: questions.length,

      marksPerQuestion,

      totalMarks: calculateTotalMarks(questions),

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
// REGENERATE SINGLE QUESTION
// ============================================================

app.post("/regenerate-question", async (req, res) => {
  try {
    if (!model) {
      return res.status(500).json({
        success: false,
        error: "Gemini API is not configured.",
      });
    }

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
Generate ONE new college-level MCQ.

Difficulty: ${difficulty}

The new question must NOT be the same as this previous question:

"${previousQuestion}"

Return ONLY valid JSON.

Required structure:

{
  "question": "Question text",
  "options": [
    "Option A",
    "Option B",
    "Option C",
    "Option D"
  ],
  "correctAnswer": 0,
  "explanation": "Short explanation",
  "difficulty": "${difficulty}"
}

Rules:

- Exactly 4 options.
- Only one correct answer.
- correctAnswer must be 0, 1, 2, or 3.
- Make the question meaningfully different.
- No Markdown.
- No text outside JSON.
`;

    const result = await model.generateContent(prompt);

    const text = result.response.text();

    const parsed = extractJson(text);

    const question = normalizeQuestion(parsed, 0, difficulty);

    question.source = "ai";

    question.excluded = false;

    return res.json({
      success: true,
      question,
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
// ============================================================

app.post("/publish-quiz", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error:
          "Database is not connected. Please configure MONGODB_URI on Render.",
      });
    }

    const incomingQuiz = req.body.quiz;

    if (!incomingQuiz) {
      return res.status(400).json({
        success: false,
        error: "Quiz data is missing.",
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

    // ========================================================
    // NORMALIZE
    // ========================================================

    const questions = incomingQuiz.questions.map((question, index) => {
      return normalizeQuestion(
        question,
        index,
        question.difficulty || "moderate",
      );
    });

    // Only active questions should be published.
    const activeQuestions = questions.filter((question) => !question.excluded);

    if (activeQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one active question is required.",
      });
    }

    // ========================================================
    // TIME LIMIT
    // ========================================================

    const timeLimit = Math.min(
      180,
      Math.max(1, Number(incomingQuiz.timeLimit) || 30),
    );

    // ========================================================
    // GENERATE CODE
    // ========================================================

    const code = await generateQuizCode();

    // ========================================================
    // CREATE QUIZ
    // ========================================================

    const quiz = new Quiz({
      code,

      title: incomingQuiz.title || "Advance's Quiz",

      success: true,

      totalQuestions: activeQuestions.length,

      marksPerQuestion: Number(incomingQuiz.marksPerQuestion) || 0,

      totalMarks: calculateTotalMarks(activeQuestions),

      difficulty: incomingQuiz.difficulty || "mixed",

      timeLimit,

      questions: activeQuestions,

      students: [],
    });

    await quiz.save();

    console.log(
      `QUIZ PUBLISHED: ${code} | ${activeQuestions.length} questions | ${timeLimit} minutes`,
    );

    return res.json({
      success: true,

      code,

      quiz: {
        code: quiz.code,

        title: quiz.title,

        totalQuestions: quiz.totalQuestions,

        marksPerQuestion: quiz.marksPerQuestion,

        totalMarks: quiz.totalMarks,

        difficulty: quiz.difficulty,

        timeLimit: quiz.timeLimit,

        questions: quiz.questions,
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
// STUDENT JOIN QUIZ
// ============================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error: "Database is not connected.",
      });
    }

    const code = cleanText(req.params.code).toUpperCase();

    const studentName = cleanText(req.body.studentName);

    const enrollment = cleanText(req.body.enrollment).toUpperCase();

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

    // ========================================================
    // FIND QUIZ
    // ========================================================

    const quiz = await Quiz.findOne({
      code,
    });

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found. Please check the quiz code.",
      });
    }

    // ========================================================
    // DUPLICATE ENROLLMENT
    // ========================================================

    const existingStudent = findStudent(quiz, enrollment);

    if (existingStudent) {
      if (existingStudent.submitted) {
        return res.status(400).json({
          success: false,
          error: "This enrollment number has already submitted this quiz.",
        });
      }

      return res.status(400).json({
        success: false,
        error: "This enrollment number has already joined this quiz.",
      });
    }

    // ========================================================
    // CALCULATE SERVER EXPIRATION
    // ========================================================

    const now = Date.now();

    const expiresAt = new Date(now + Number(quiz.timeLimit || 30) * 60 * 1000);

    // ========================================================
    // ADD STUDENT
    // ========================================================

    quiz.students.push({
      studentName,

      enrollment,

      joinedAt: new Date(now),

      expiresAt,

      submittedAt: null,

      submitted: false,

      answers: {},

      result: null,
    });

    await quiz.save();

    // Get newly created student.
    const student = quiz.students[quiz.students.length - 1];

    console.log(
      `STUDENT JOINED: ${studentName} | ${enrollment} | QUIZ ${code}`,
    );

    return res.json({
      success: true,

      student: {
        id: student._id,

        studentName: student.studentName,

        enrollment: student.enrollment,

        joinedAt: student.joinedAt,

        expiresAt: student.expiresAt,
      },
    });
  } catch (error) {
    console.error("JOIN QUIZ ERROR:");

    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to join quiz.",
    });
  }
});

// ============================================================
// GET QUIZ
// ============================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error: "Database is not connected.",
      });
    }

    const code = cleanText(req.params.code).toUpperCase();

    const quiz = await Quiz.findOne({
      code,
    }).lean();

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    // ========================================================
    // NEVER SEND STUDENT PRIVATE DATA
    // ========================================================

    const safeQuiz = {
      code: quiz.code,

      title: quiz.title,

      success: quiz.success,

      totalQuestions: quiz.totalQuestions,

      marksPerQuestion: quiz.marksPerQuestion,

      totalMarks: quiz.totalMarks,

      difficulty: quiz.difficulty,

      timeLimit: quiz.timeLimit,

      questions: quiz.questions.map((question) => ({
        id: question.id,

        question: question.question,

        options: question.options,

        correctAnswer: question.correctAnswer,

        explanation: question.explanation,

        difficulty: question.difficulty,

        marks: question.marks,

        excluded: question.excluded,

        source: question.source,
      })),
    };

    return res.json({
      success: true,
      quiz: safeQuiz,
    });
  } catch (error) {
    console.error("GET QUIZ ERROR:");

    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load quiz.",
    });
  }
});

// ============================================================
// STUDENT COUNT
// ============================================================

app.get("/quiz/:code/student-count", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error: "Database is not connected.",
      });
    }

    const code = cleanText(req.params.code).toUpperCase();

    const quiz = await Quiz.findOne({
      code,
    }).lean();

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const totalStudents = Array.isArray(quiz.students)
      ? quiz.students.length
      : 0;

    return res.json({
      success: true,

      totalStudents,
    });
  } catch (error) {
    console.error("STUDENT COUNT ERROR:");

    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to get student count.",
    });
  }
});

// ============================================================
// SUBMIT QUIZ
// ============================================================

app.post("/quiz/:code/submit", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error: "Database is not connected.",
      });
    }

    const code = cleanText(req.params.code).toUpperCase();

    const enrollment = cleanText(req.body.enrollment).toUpperCase();

    const answers =
      req.body.answers && typeof req.body.answers === "object"
        ? req.body.answers
        : {};

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    // ========================================================
    // FIND QUIZ
    // ========================================================

    const quiz = await Quiz.findOne({
      code,
    });

    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    // ========================================================
    // FIND STUDENT
    // ========================================================

    const student = findStudent(quiz, enrollment);

    if (!student) {
      return res.status(404).json({
        success: false,
        error: "Student attempt not found. Please join the quiz first.",
      });
    }

    // ========================================================
    // ALREADY SUBMITTED
    // ========================================================

    if (student.submitted) {
      return res.status(400).json({
        success: false,
        error: "This quiz has already been submitted.",
      });
    }

    // ========================================================
    // SERVER TIMER CHECK
    // ========================================================

    const now = Date.now();

    const expiresAt = new Date(student.expiresAt).getTime();

    const expired = now > expiresAt;

    // We still calculate the submitted answers.
    // If expired, the attempt is marked as automatically submitted.
    // This is important because the frontend timer cannot be trusted
    // by itself.
    // ========================================================

    student.answers = answers;

    student.submitted = true;

    student.submittedAt = new Date(now);

    // ========================================================
    // CALCULATE SCORE
    // ========================================================

    const result = calculateResult(quiz, student);

    student.result = result;

    await quiz.save();

    console.log(
      `${expired ? "AUTO" : "NORMAL"} SUBMISSION: ${enrollment} | QUIZ ${code} | SCORE ${result.score}/${result.totalMarks}`,
    );

    return res.json({
      success: true,

      expired,

      result,
    });
  } catch (error) {
    console.error("SUBMIT QUIZ ERROR:");

    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to submit quiz.",
    });
  }
});

// ============================================================
// DELETE QUIZ
// Optional admin/debug endpoint
// ============================================================

app.delete("/quiz/:code", async (req, res) => {
  try {
    if (!databaseReady) {
      return res.status(500).json({
        success: false,
        error: "Database is not connected.",
      });
    }

    const code = cleanText(req.params.code).toUpperCase();

    const result = await Quiz.deleteOne({
      code,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    return res.json({
      success: true,
      message: "Quiz deleted.",
    });
  } catch (error) {
    console.error("DELETE QUIZ ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,

    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("GLOBAL SERVER ERROR:");

  console.error(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: `Upload error: ${error.message}`,
    });
  }

  return res.status(500).json({
    success: false,

    error: error.message || "Internal server error.",
  });
});

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  await connectDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("==============================================");
    console.log("       ADVANCE'S QUIZ SERVER");
    console.log("==============================================");
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`MongoDB: ${databaseReady ? "CONNECTED" : "NOT CONNECTED"}`);
    console.log(`Gemini: ${model ? GEMINI_MODEL : "NOT CONFIGURED"}`);
    console.log("==============================================");
    console.log("");
  });
}

startServer();

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED PROMISE REJECTION:");

  console.error(error);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:");

  console.error(error);
});

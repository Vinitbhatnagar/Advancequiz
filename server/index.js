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

const db = getFirestore();

console.log("Firebase Admin initialized successfully.");

// =========================================================
// EXPRESS
// =========================================================

const app = express();

app.use(cors());
app.use(express.json());

// =========================================================
// TEMPORARY PDF CONTEXT
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

const GEMINI_MODEL = "gemini-2.5-flash";

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
  }

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
  }

  return cleaned;
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

// =========================================================
// HOME
// =========================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Advance's Quiz Backend Running!",
  });
});

// =========================================================
// GENERATE QUIZ
// =========================================================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  let filePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a PDF file.",
      });
    }

    filePath = req.file.path;

    const numberOfQuestions = Number(req.body.numberOfQuestions) || 5;

    const marksPerQuestion = Number(req.body.marksPerQuestion) || 1;

    const difficulty = req.body.difficulty || "moderate";

    const timeLimit = Number(req.body.timeLimit) || 30;

    console.log("PDF received:", req.file.originalname);
    console.log("Questions:", numberOfQuestions);
    console.log("Marks:", marksPerQuestion);
    console.log("Difficulty:", difficulty);
    console.log("Time:", timeLimit);

    // -----------------------------------------------------
    // EXTRACT PDF
    // -----------------------------------------------------

    const dataBuffer = fs.readFileSync(filePath);

    const pdfData = await pdf(dataBuffer);

    const extractedText = pdfData.text.trim();

    if (!extractedText) {
      throw new Error(
        "Could not extract text from this PDF. It may be an image/scanned PDF.",
      );
    }

    console.log("Extracted characters:", extractedText.length);

    // Keep context for regeneration.
    lastPdfText = extractedText.slice(0, 60000);

    // -----------------------------------------------------
    // GEMINI
    // -----------------------------------------------------

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
    });

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

Rules:

1. Questions must be based ONLY on the provided PDF.
2. Create exactly ${numberOfQuestions} questions.
3. Every question must have exactly 4 options.
4. Only ONE option may be correct.
5. Avoid duplicate questions.
6. Avoid ambiguous questions.
7. Incorrect options must be plausible.
8. Do not invent facts.
9. Return ONLY valid JSON.
10. Do not use markdown.
11. Do not use code fences.

Marks per question:
${marksPerQuestion}

Return exactly:

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
      "explanation": "Short explanation"
    }
  ]
}

correctAnswer:
0 = Option A
1 = Option B
2 = Option C
3 = Option D

STUDY MATERIAL:

${lastPdfText}
`;

    console.log("Generating questions with Gemini...");

    const result = await model.generateContent(prompt);

    const responseText = result.response.text();

    const cleanedResponse = cleanGeminiResponse(responseText);

    let quizData;

    try {
      quizData = JSON.parse(cleanedResponse);
    } catch (error) {
      console.error("Invalid Gemini JSON:");
      console.error(responseText);

      throw new Error("AI returned an invalid quiz format. Please try again.");
    }

    // -----------------------------------------------------
    // VALIDATE
    // -----------------------------------------------------

    if (!quizData.questions || !Array.isArray(quizData.questions)) {
      throw new Error("AI did not return a valid question list.");
    }

    const validQuestions = quizData.questions
      .slice(0, numberOfQuestions)
      .filter((question) => {
        return (
          question.question &&
          Array.isArray(question.options) &&
          question.options.length === 4 &&
          Number.isInteger(question.correctAnswer) &&
          question.correctAnswer >= 0 &&
          question.correctAnswer <= 3
        );
      })
      .map((question) => ({
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation || "",
        marks: marksPerQuestion,
        difficulty,
      }));

    if (validQuestions.length !== numberOfQuestions) {
      throw new Error(
        `AI generated ${validQuestions.length} valid questions instead of ${numberOfQuestions}.`,
      );
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
    console.error("GENERATE QUIZ ERROR:", error);

    res.status(500).json({
      success: false,
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
    if (!lastPdfText) {
      return res.status(400).json({
        success: false,
        error: "PDF context not found. Please generate the quiz again.",
      });
    }

    const { difficulty, previousQuestion } = req.body;

    const selectedDifficulty = difficulty || "moderate";

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
    });

    const prompt = `
You are an expert college examination question generator.

Generate EXACTLY ONE new multiple-choice question.

The question MUST be based ONLY on the provided PDF.

DIFFICULTY:
${selectedDifficulty}

Rules:

1. Generate exactly ONE question.
2. Generate exactly FOUR options.
3. Only ONE option can be correct.
4. Do not repeat the previous question.
5. Do not make a minor rewording of it.
6. Make incorrect options plausible.
7. Avoid ambiguity.
8. Do not invent information.
9. Return ONLY JSON.
10. No markdown.
11. No code fences.

PREVIOUS QUESTION:

${previousQuestion || "None"}

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
  "explanation": "Short explanation"
}

PDF:

${lastPdfText}
`;

    console.log("Regenerating question...");

    const result = await model.generateContent(prompt);

    const cleanedResponse = cleanGeminiResponse(result.response.text());

    let newQuestion;

    try {
      newQuestion = JSON.parse(cleanedResponse);
    } catch (error) {
      throw new Error("AI returned an invalid question format.");
    }

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
    console.error("REGENERATE QUESTION ERROR:", error);

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

    if (!quiz || !quiz.questions || !Array.isArray(quiz.questions)) {
      return res.status(400).json({
        success: false,
        error: "Invalid quiz data.",
      });
    }

    // -----------------------------------------------------
    // UNIQUE CODE
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
    // QUIZ DATA
    // -----------------------------------------------------

    const timeLimit = Number(quiz.timeLimit) || 30;

    const totalQuestions = quiz.questions.length;

    const marksPerQuestion = Number(quiz.marksPerQuestion) || 1;

    const totalMarks =
      Number(quiz.totalMarks) || totalQuestions * marksPerQuestion;

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

    console.log("Quiz published:", code);

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
// STUDENT-SAFE VERSION
// NEVER SENDS correctAnswer
// =========================================================

app.get("/quiz/:code", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found or no longer available.",
      });
    }

    const quiz = quizSnapshot.data();

    const safeQuestions = (quiz.questions || []).map((question) => ({
      question: question.question,

      options: question.options,

      marks: question.marks,

      difficulty: question.difficulty,
    }));

    res.json({
      success: true,

      quiz: {
        code: quiz.code,

        status: quiz.status,

        createdAt: quiz.createdAt,

        timeLimit: quiz.timeLimit,

        totalQuestions: quiz.totalQuestions,

        marksPerQuestion: quiz.marksPerQuestion,

        totalMarks: quiz.totalMarks,

        totalStudents: quiz.totalStudents || 0,

        questions: safeQuestions,
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

// =========================================================
// STUDENT JOIN QUIZ
// DUPLICATE PROTECTION + TIMER START
// =========================================================

app.post("/quiz/:code/join", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const { studentName, enrollment } = req.body;

    // -----------------------------------------------------
    // VALIDATION
    // -----------------------------------------------------

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({
        success: false,
        error: "Student name is required.",
      });
    }

    if (!enrollment || !enrollment.trim()) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    const cleanName = studentName.trim();

    const cleanEnrollment = normalizeEnrollment(enrollment);

    // -----------------------------------------------------
    // QUIZ
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

    if (quiz.status && quiz.status !== "live") {
      return res.status(403).json({
        success: false,
        error: "This quiz is no longer accepting students.",
      });
    }

    // -----------------------------------------------------
    // STUDENT DOCUMENT
    // -----------------------------------------------------

    const studentRef = quizRef.collection("students").doc(cleanEnrollment);

    // -----------------------------------------------------
    // TRANSACTION
    // -----------------------------------------------------

    const result = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(studentRef);

      if (existing.exists) {
        throw new Error("DUPLICATE_ENROLLMENT");
      }

      const startedAt = new Date();

      const timeLimit = Number(quiz.timeLimit) || 30;

      const expiresAt = new Date(startedAt.getTime() + timeLimit * 60 * 1000);

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

      transaction.set(studentRef, student);

      const currentCount = Number(quiz.totalStudents || 0);

      transaction.update(quizRef, {
        totalStudents: currentCount + 1,
      });

      return {
        student,

        totalStudents: currentCount + 1,
      };
    });

    console.log(`Student started ${code}: ${cleanName} (${cleanEnrollment})`);

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
    if (error.message === "DUPLICATE_ENROLLMENT") {
      return res.status(409).json({
        success: false,
        error: "This enrollment number has already joined this test.",
      });
    }

    console.error("STUDENT JOIN ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to start quiz.",
    });
  }
});

// =========================================================
// SUBMIT QUIZ
// =========================================================
//
// Frontend sends:
//
// {
//   "enrollment": "BCA001",
//   "answers": {
//      "0": 1,
//      "1": 3,
//      "2": 0
//   }
// }
//
// Answer values are option indexes.
// =========================================================

app.post("/quiz/:code/submit", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const { enrollment, answers } = req.body;

    // ---------------------------------------------------
    // VALIDATION
    // ---------------------------------------------------

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        error: "Enrollment number is required.",
      });
    }

    if (!answers || typeof answers !== "object") {
      return res.status(400).json({
        success: false,
        error: "Answers are required.",
      });
    }

    const cleanEnrollment = normalizeEnrollment(enrollment);

    // ---------------------------------------------------
    // GET QUIZ
    // ---------------------------------------------------

    const quizRef = db.collection("quizzes").doc(code);

    const quizSnapshot = await quizRef.get();

    if (!quizSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Quiz not found.",
      });
    }

    const quiz = quizSnapshot.data();

    // ---------------------------------------------------
    // GET STUDENT
    // ---------------------------------------------------

    const studentRef = quizRef.collection("students").doc(cleanEnrollment);

    const studentSnapshot = await studentRef.get();

    if (!studentSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "Student attempt not found. Please join the quiz first.",
      });
    }

    const student = studentSnapshot.data();

    // ---------------------------------------------------
    // ALREADY SUBMITTED
    // ---------------------------------------------------

    if (student.submitted) {
      return res.status(409).json({
        success: false,
        error: "This quiz has already been submitted.",
      });
    }

    // ---------------------------------------------------
    // TIMER CHECK
    // ---------------------------------------------------

    const now = new Date();

    const expiresAt = new Date(student.expiresAt);

    const isExpired = now > expiresAt;

    // ---------------------------------------------------
    // CALCULATE SCORE
    // ---------------------------------------------------

    const questions = quiz.questions || [];

    const marksPerQuestion = Number(quiz.marksPerQuestion) || 1;

    let score = 0;

    const review = [];

    questions.forEach((question, index) => {
      const selectedAnswer =
        answers[index] !== undefined ? Number(answers[index]) : null;

      const correctAnswer = Number(question.correctAnswer);

      const isCorrect =
        selectedAnswer !== null && selectedAnswer === correctAnswer;

      if (isCorrect) {
        score += Number(question.marks || marksPerQuestion);
      }

      review.push({
        question: question.question,

        options: question.options,

        selectedAnswer,

        correctAnswer,

        isCorrect,

        marks: Number(question.marks || marksPerQuestion),

        explanation: question.explanation || "",
      });
    });

    const totalMarks =
      Number(quiz.totalMarks) ||
      questions.reduce(
        (total, question) => total + Number(question.marks || marksPerQuestion),
        0,
      );

    const percentage =
      totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(2)) : 0;

    // ---------------------------------------------------
    // FINAL STATUS
    // ---------------------------------------------------

    const finalStatus = isExpired ? "time_expired" : "submitted";

    const submittedAt = now.toISOString();

    // ---------------------------------------------------
    // SAVE RESULT
    // ---------------------------------------------------

    await studentRef.update({
      answers,

      submitted: true,

      submittedAt,

      score,

      totalMarks,

      percentage,

      status: finalStatus,
    });

    console.log(
      `Quiz submitted: ${code} / ${cleanEnrollment} / ${score}/${totalMarks}`,
    );

    // ---------------------------------------------------
    // RESPONSE
    // ---------------------------------------------------

    res.json({
      success: true,

      message: isExpired
        ? "Time expired. Your answers were submitted automatically."
        : "Quiz submitted successfully.",

      result: {
        quizCode: code,

        enrollment: cleanEnrollment,

        studentName: student.studentName,

        score,

        totalMarks,

        percentage,

        submittedAt,

        status: finalStatus,

        totalQuestions: questions.length,
      },

      review,
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
// VIEW SCORE
// =========================================================
//
// GET:
// /quiz/STXABC123/result/BCA001
// =========================================================

app.get("/quiz/:code/result/:enrollment", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const enrollment = normalizeEnrollment(req.params.enrollment);

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
        error: "Student result not found.",
      });
    }

    const student = studentSnapshot.data();

    if (!student.submitted) {
      return res.status(400).json({
        success: false,
        error: "Quiz has not been submitted yet.",
      });
    }

    res.json({
      success: true,

      result: {
        quizCode: code,

        studentName: student.studentName,

        enrollment: student.enrollment,

        score: student.score,

        totalMarks: student.totalMarks,

        percentage: student.percentage,

        submittedAt: student.submittedAt,

        status: student.status,

        totalQuestions: quiz.totalQuestions || quiz.questions.length,
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
// REVIEW ANSWERS
// =========================================================
//
// GET:
// /quiz/STXABC123/review/BCA001
//
// Correct answers are ONLY exposed after submission.
// =========================================================

app.get("/quiz/:code/review/:enrollment", async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);

    const enrollment = normalizeEnrollment(req.params.enrollment);

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
        error: "Student attempt not found.",
      });
    }

    const student = studentSnapshot.data();

    if (!student.submitted) {
      return res.status(403).json({
        success: false,
        error: "Answer review is available only after submission.",
      });
    }

    const answers = student.answers || {};

    const questions = quiz.questions || [];

    const review = questions.map((question, index) => {
      const selectedAnswer =
        answers[index] !== undefined ? Number(answers[index]) : null;

      const correctAnswer = Number(question.correctAnswer);

      const isCorrect =
        selectedAnswer !== null && selectedAnswer === correctAnswer;

      return {
        question: question.question,

        options: question.options,

        selectedAnswer,

        correctAnswer,

        isCorrect,

        marks: Number(question.marks || quiz.marksPerQuestion || 1),

        explanation: question.explanation || "",
      };
    });

    res.json({
      success: true,

      quizCode: code,

      studentName: student.studentName,

      enrollment: student.enrollment,

      score: student.score,

      totalMarks: student.totalMarks,

      percentage: student.percentage,

      status: student.status,

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
// GET STUDENTS
// =========================================================
//
// Useful for teacher/admin MVP.
// =========================================================

app.get("/quiz/:code/students", async (req, res) => {
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

    const studentsSnapshot = await quizRef
      .collection("students")
      .orderBy("joinedAt", "asc")
      .get();

    const students = studentsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,

      quizCode: code,

      totalStudents: students.length,

      students,
    });
  } catch (error) {
    console.error("GET STUDENTS ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Failed to load students.",
    });
  }
});

// =========================================================
// LIVE STUDENT COUNT
// =========================================================

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

    res.json({
      success: true,

      quizCode: code,

      totalStudents: studentsSnapshot.size,
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

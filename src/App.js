import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { QRCodeCanvas } from "qrcode.react";
import "./App.css";

function App() {
  const [role, setRole] = useState(null);

  // =========================================================
  // TEACHER STATE
  // =========================================================

  const [file, setFile] = useState(null);

  const [numberOfQuestions, setNumberOfQuestions] = useState(10);

  const [marksPerQuestion, setMarksPerQuestion] = useState(2);

  const [difficulty, setDifficulty] = useState("moderate");

  const [creationMode, setCreationMode] = useState(null);

  const [loading, setLoading] = useState(false);

  const [quiz, setQuiz] = useState(null);

  const [quizCode, setQuizCode] = useState(null);

  const [published, setPublished] = useState(false);

  const [regeneratingQuestion, setRegeneratingQuestion] = useState(null);

  // Custom quiz time in minutes
  const [timeLimit, setTimeLimit] = useState(30);

  // =========================================================
  // MANUAL QUESTION STATE
  // =========================================================

  const [manualQuestion, setManualQuestion] = useState("");

  const [manualOptions, setManualOptions] = useState(["", "", "", ""]);

  const [manualCorrectAnswer, setManualCorrectAnswer] = useState(0);

  const [manualDifficulty, setManualDifficulty] = useState("moderate");

  const [manualMarks, setManualMarks] = useState(2);

  const [manualExplanation, setManualExplanation] = useState("");

  const [manualQuestions, setManualQuestions] = useState([]);

  // =========================================================
  // STUDENT STATE
  // =========================================================

  const [studentQuiz, setStudentQuiz] = useState(null);

  const [currentQuestion, setCurrentQuestion] = useState(0);

  const [studentAnswers, setStudentAnswers] = useState({});

  const [quizStarted, setQuizStarted] = useState(false);

  const [studentCount, setStudentCount] = useState(0);

  const [studentName, setStudentName] = useState("");

  const [enrollment, setEnrollment] = useState("");

  const [joinCode, setJoinCode] = useState("");

  const [studentResult, setStudentResult] = useState(null);

  const [timeLeft, setTimeLeft] = useState(0);

  const [submittingQuiz, setSubmittingQuiz] = useState(false);

  // =========================================================
  // FORMAT TIMER
  // =========================================================

  const formatTime = (seconds) => {
    const safeSeconds = Math.max(0, Number(seconds) || 0);

    const minutes = Math.floor(safeSeconds / 60);

    const remainingSeconds = safeSeconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds,
    ).padStart(2, "0")}`;
  };

  // =========================================================
  // SUBMIT QUIZ
  // =========================================================

  const submitQuiz = useCallback(
    async (autoSubmit = false) => {
      if (!studentQuiz || submittingQuiz || studentResult) {
        return;
      }

      const confirmed = autoSubmit
        ? true
        : window.confirm("Are you sure you want to submit the quiz?");

      if (!confirmed) {
        return;
      }

      setSubmittingQuiz(true);

      try {
        const code = studentQuiz.code.toUpperCase();

        const cleanEnrollment = enrollment.trim().toUpperCase();

        if (!cleanEnrollment) {
          throw new Error("Enrollment number is missing.");
        }

        const response = await axios.post(
          `https://advancequiz.onrender.com/quiz/${code}/submit`,
          {
            enrollment: cleanEnrollment,
            answers: studentAnswers,
          },
        );

        console.log("QUIZ SUBMITTED:", response.data);

        if (!response.data.success) {
          throw new Error(response.data.error || "Failed to submit quiz.");
        }

        setStudentResult(response.data.result);

        setQuizStarted(false);

        setTimeLeft(0);
      } catch (error) {
        console.error("SUBMIT QUIZ ERROR:", error);

        alert(
          error.response?.data?.error ||
            error.message ||
            "Failed to submit quiz.",
        );
      } finally {
        setSubmittingQuiz(false);
      }
    },
    [studentQuiz, submittingQuiz, studentResult, enrollment, studentAnswers],
  );

  // =========================================================
  // STUDENT TIMER
  // =========================================================
  //
  // The server gives us expiresAt when the student joins.
  // The frontend counts down from that server-controlled time.
  //
  // =========================================================

  useEffect(() => {
    if (!quizStarted || !studentQuiz || studentResult) {
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((previous) => {
        if (previous <= 1) {
          clearInterval(timer);
          return 0;
        }

        return previous - 1;
      });
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [quizStarted, studentQuiz, studentResult]);

  // =========================================================
  // AUTO SUBMIT WHEN TIMER REACHES ZERO
  // =========================================================

  useEffect(() => {
    if (!quizStarted || !studentQuiz || studentResult) {
      return;
    }

    if (timeLeft > 0) {
      return;
    }

    if (submittingQuiz) {
      return;
    }

    submitQuiz(true);
  }, [
    quizStarted,
    studentQuiz,
    studentResult,
    timeLeft,
    submittingQuiz,
    submitQuiz,
  ]);

  // =========================================================
  // LIVE STUDENT COUNT
  // =========================================================

  useEffect(() => {
    if (!published || !quizCode) {
      return;
    }

    let interval;

    const fetchStudentCount = async () => {
      try {
        const response = await axios.get(
          `https://advancequiz.onrender.com/quiz/${quizCode}/student-count`,
        );

        if (response.data.success) {
          setStudentCount(response.data.totalStudents || 0);
        }
      } catch (error) {
        console.error("STUDENT COUNT ERROR:", error);
      }
    };

    fetchStudentCount();

    interval = setInterval(fetchStudentCount, 3000);

    return () => {
      clearInterval(interval);
    };
  }, [published, quizCode]);

  // =========================================================
  // AUTO JOIN FROM /join/CODE URL
  // =========================================================

  useEffect(() => {
    const path = window.location.pathname;

    if (path.startsWith("/join/")) {
      const code = path.split("/join/")[1];

      if (code) {
        setRole("student");
        setJoinCode(code.toUpperCase());
      }
    }
  }, []);

  // =========================================================
  // STUDENT BASIC COPY PROTECTION
  // =========================================================

  useEffect(() => {
    if (!(role === "student" && quizStarted)) {
      return;
    }

    const prevent = (e) => e.preventDefault();

    document.addEventListener("contextmenu", prevent);
    document.addEventListener("copy", prevent);
    document.addEventListener("cut", prevent);
    document.addEventListener("paste", prevent);

    return () => {
      document.removeEventListener("contextmenu", prevent);
      document.removeEventListener("copy", prevent);
      document.removeEventListener("cut", prevent);
      document.removeEventListener("paste", prevent);
    };
  }, [role, quizStarted]);

  // =========================================================
  // STUDENT ANTI-COPY / PASTE PROTECTION
  // =========================================================

  useEffect(() => {
    if (role !== "student" || !quizStarted) {
      return;
    }

    const preventCopyPaste = (e) => {
      e.preventDefault();
    };

    const preventContextMenu = (e) => {
      e.preventDefault();
    };

    const preventDrag = (e) => {
      e.preventDefault();
    };

    const preventKeyboardShortcuts = (e) => {
      const key = e.key.toLowerCase();

      // Copy / paste / cut / select all
      if ((e.ctrlKey || e.metaKey) && ["c", "v", "x", "a"].includes(key)) {
        e.preventDefault();
        return;
      }

      // DevTools shortcuts
      if (
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && ["i", "j", "c"].includes(key))
      ) {
        e.preventDefault();
      }
    };

    document.addEventListener("copy", preventCopyPaste);
    document.addEventListener("cut", preventCopyPaste);
    document.addEventListener("paste", preventCopyPaste);
    document.addEventListener("contextmenu", preventContextMenu);
    document.addEventListener("dragstart", preventDrag);
    document.addEventListener("keydown", preventKeyboardShortcuts);

    return () => {
      document.removeEventListener("copy", preventCopyPaste);
      document.removeEventListener("cut", preventCopyPaste);
      document.removeEventListener("paste", preventCopyPaste);
      document.removeEventListener("contextmenu", preventContextMenu);
      document.removeEventListener("dragstart", preventDrag);
      document.removeEventListener("keydown", preventKeyboardShortcuts);
    };
  }, [role, quizStarted]);

  // =========================================================
  // GENERATE QUIZ WITH AI
  // =========================================================

  const generateQuiz = async () => {
    if (!file) {
      alert("Please upload a PDF first.");
      return;
    }

    setLoading(true);
    setQuiz(null);
    setPublished(false);

    try {
      const formData = new FormData();

      formData.append("pdf", file);

      formData.append("numberOfQuestions", Number(numberOfQuestions));

      formData.append("marksPerQuestion", Number(marksPerQuestion));

      formData.append("difficulty", difficulty);

      formData.append("timeLimit", Number(timeLimit));

      const response = await axios.post(
        "https://advancequiz.onrender.com/generate-quiz",
        formData,
      );

      const updatedQuestions = response.data.questions.map(
        (question, index) => ({
          ...question,
          id: index + 1,
          difficulty: question.difficulty || difficulty,
          excluded: false,
          source: "ai",
        }),
      );

      setQuiz({
        ...response.data,

        questions: updatedQuestions,

        // IMPORTANT:
        // Save custom timer inside the quiz object.
        timeLimit: Number(timeLimit),
      });
    } catch (error) {
      console.error(error);

      alert(
        error.response?.data?.error ||
          "Something went wrong while generating the quiz.",
      );
    } finally {
      setLoading(false);
    }
  };

  // =========================================================
  // MANUAL QUESTION - OPTION CHANGE
  // =========================================================

  const updateManualOption = (index, value) => {
    setManualOptions((previousOptions) => {
      const updated = [...previousOptions];

      updated[index] = value;

      return updated;
    });
  };

  // =========================================================
  // ADD MANUAL QUESTION
  // =========================================================

  const addManualQuestion = () => {
    const trimmedQuestion = manualQuestion.trim();

    const trimmedOptions = manualOptions.map((option) => option.trim());

    if (!trimmedQuestion) {
      alert("Please enter the question.");
      return;
    }

    if (trimmedOptions.some((option) => !option)) {
      alert("Please fill all four options.");
      return;
    }

    const newQuestion = {
      id: Date.now() + Math.random(),

      question: trimmedQuestion,

      options: trimmedOptions,

      correctAnswer: Number(manualCorrectAnswer),

      explanation: manualExplanation.trim(),

      difficulty: manualDifficulty,

      marks: Number(manualMarks) || 1,

      excluded: false,

      source: "manual",
    };

    setManualQuestions((previousQuestions) => [
      ...previousQuestions,
      newQuestion,
    ]);

    setManualQuestion("");

    setManualOptions(["", "", "", ""]);

    setManualCorrectAnswer(0);

    setManualExplanation("");
  };

  // =========================================================
  // REMOVE MANUAL DRAFT QUESTION
  // =========================================================

  const removeManualDraft = (questionId) => {
    setManualQuestions((previousQuestions) =>
      previousQuestions.filter((question) => question.id !== questionId),
    );
  };

  // =========================================================
  // CREATE QUIZ FROM MANUAL QUESTIONS
  // =========================================================

  const createManualQuiz = () => {
    if (manualQuestions.length === 0) {
      alert("Please add at least one question.");
      return;
    }

    const totalMarks = manualQuestions.reduce(
      (total, question) => total + Number(question.marks || 0),
      0,
    );

    setQuiz({
      success: true,

      totalQuestions: manualQuestions.length,

      marksPerQuestion: manualQuestions.every(
        (question) => question.marks === manualQuestions[0].marks,
      )
        ? manualQuestions[0].marks
        : 0,

      totalMarks,

      difficulty: "mixed",

      // IMPORTANT:
      // Manual quizzes also use the custom timer.
      timeLimit: Number(timeLimit),

      questions: manualQuestions.map((question) => ({
        ...question,
      })),
    });

    setPublished(false);
  };

  // =========================================================
  // CHANGE QUESTION DIFFICULTY
  // =========================================================

  const changeDifficulty = (questionId, newDifficulty) => {
    setQuiz((previousQuiz) => {
      if (!previousQuiz) {
        return previousQuiz;
      }

      return {
        ...previousQuiz,

        questions: previousQuiz.questions.map((question) =>
          question.id === questionId
            ? {
                ...question,
                difficulty: newDifficulty,
              }
            : question,
        ),
      };
    });
  };

  // =========================================================
  // EXCLUDE QUESTION
  // =========================================================

  const excludeQuestion = (questionId) => {
    setQuiz((previousQuiz) => {
      if (!previousQuiz) {
        return previousQuiz;
      }

      return {
        ...previousQuiz,

        questions: previousQuiz.questions.map((question) =>
          question.id === questionId
            ? {
                ...question,
                excluded: true,
              }
            : question,
        ),
      };
    });
  };

  // =========================================================
  // RESTORE QUESTION
  // =========================================================

  const restoreQuestion = (questionId) => {
    setQuiz((previousQuiz) => {
      if (!previousQuiz) {
        return previousQuiz;
      }

      return {
        ...previousQuiz,

        questions: previousQuiz.questions.map((question) =>
          question.id === questionId
            ? {
                ...question,
                excluded: false,
              }
            : question,
        ),
      };
    });
  };

  // =========================================================
  // REGENERATE QUESTION WITH AI
  // =========================================================

  const regenerateQuestion = async (questionId) => {
    if (!quiz) {
      return;
    }

    const question = quiz.questions.find((q) => q.id === questionId);

    if (!question) {
      return;
    }

    setRegeneratingQuestion(questionId);

    try {
      const response = await axios.post(
        "https://advancequiz.onrender.com/regenerate-question",
        {
          difficulty: question.difficulty || "moderate",
          previousQuestion: question.question,
        },
      );

      const newQuestion = response.data.question;

      setQuiz((prevQuiz) => ({
        ...prevQuiz,

        questions: prevQuiz.questions.map((item) =>
          item.id === questionId
            ? {
                ...item,

                question: newQuestion.question,

                options: newQuestion.options,

                correctAnswer: newQuestion.correctAnswer,

                explanation: newQuestion.explanation || "",

                difficulty:
                  newQuestion.difficulty || item.difficulty || "moderate",

                excluded: false,
              }
            : item,
        ),
      }));
    } catch (error) {
      console.error(error);

      alert(error.response?.data?.error || "Failed to regenerate question.");
    } finally {
      setRegeneratingQuestion(null);
    }
  };

  // =========================================================
  // ACTIVE QUESTIONS
  // =========================================================

  const getActiveQuestions = () => {
    if (!quiz) {
      return [];
    }

    return quiz.questions.filter((question) => !question.excluded);
  };

  // =========================================================
  // TOTAL MARKS
  // =========================================================

  const getCurrentTotalMarks = () => {
    return getActiveQuestions().reduce(
      (total, question) =>
        total +
        Number(
          question.marks || quiz?.marksPerQuestion || marksPerQuestion || 0,
        ),
      0,
    );
  };

  // =========================================================
  // PUBLISH QUIZ
  // =========================================================

  const publishQuiz = async () => {
    const activeQuestions = getActiveQuestions();

    if (activeQuestions.length === 0) {
      alert("Please keep at least one question before publishing.");
      return;
    }

    try {
      const finalTimeLimit = Math.min(
        180,
        Math.max(1, Number(quiz?.timeLimit || timeLimit || 30)),
      );

      const quizToPublish = {
        ...quiz,

        questions: activeQuestions,

        totalQuestions: activeQuestions.length,

        totalMarks: getCurrentTotalMarks(),

        // IMPORTANT:
        // This is the timer the backend should use.
        timeLimit: finalTimeLimit,
      };

      console.log(
        "PUBLISHING QUIZ WITH TIME LIMIT:",
        finalTimeLimit,
        "minutes",
      );

      const response = await axios.post(
        "https://advancequiz.onrender.com/publish-quiz",
        {
          quiz: quizToPublish,
        },
      );

      setQuiz((previousQuiz) => ({
        ...previousQuiz,
        ...quizToPublish,
      }));

      setQuizCode(response.data.code);

      setPublished(true);
    } catch (error) {
      console.error(error);

      alert(error.response?.data?.error || "Failed to publish quiz.");
    }
  };

  // =========================================================
  // RESET
  // =========================================================

  const goHome = () => {
    // General
    setRole(null);

    // Teacher
    setFile(null);

    setQuiz(null);

    setPublished(false);

    setQuizCode("");

    setManualQuestions([]);

    setRegeneratingQuestion(null);

    setCreationMode(null);

    setTimeLimit(30);

    // Student
    setStudentQuiz(null);

    setQuizStarted(false);

    setCurrentQuestion(0);

    setStudentAnswers({});

    setStudentName("");

    setEnrollment("");

    setJoinCode("");

    setStudentResult(null);

    setTimeLeft(0);

    setSubmittingQuiz(false);

    setStudentCount(0);
  };

  // =========================================================
  // LANDING PAGE
  // =========================================================

  if (!role) {
    return (
      <div className="app">
        <div className="landing-container">
          <div className="brand">
            <div className="brand-icon">AQ</div>

            <h1>
              Advance's <span>Quiz</span>
            </h1>

            <p>AI-powered quizzes created directly from your study material.</p>
          </div>

          <div className="role-grid">
            <button className="role-card" onClick={() => setRole("teacher")}>
              <div className="role-icon">👨‍🏫</div>

              <h2>Teacher</h2>

              <p>Create quizzes with AI or manually add your own MCQs.</p>

              <span className="role-button">Create Quiz →</span>
            </button>

            <button className="role-card" onClick={() => setRole("student")}>
              <div className="role-icon">🎓</div>

              <h2>Student</h2>

              <p>
                Scan the classroom QR code or enter a quiz code to start your
                test.
              </p>

              <span className="role-button">Join Quiz →</span>
            </button>
          </div>

          <div className="footer-text">Built for smarter classrooms</div>
        </div>
      </div>
    );
  }

  // =========================================================
  // TEACHER PANEL
  // =========================================================

  if (role === "teacher") {
    return (
      <div className="app">
        <div className="topbar">
          <button onClick={goHome} className="back-button">
            ← Home
          </button>

          <h2>
            Advance's <span>Quiz</span>
          </h2>
        </div>

        <main className="dashboard">
          {/* =================================================
              CREATION MODE SELECTION
          ================================================= */}

          {!quiz && !creationMode && (
            <div className="review-section">
              <div className="page-heading">
                <span className="eyebrow">TEACHER PANEL</span>

                <h1>Create your quiz</h1>

                <p>Choose how you want to create your MCQs.</p>
              </div>

              <div className="role-grid">
                <button
                  className="role-card"
                  onClick={() => setCreationMode("ai")}
                >
                  <div className="role-icon">✨</div>

                  <h2>AI Generate MCQs</h2>

                  <p>
                    Upload a PDF and let Gemini automatically create
                    college-level MCQs.
                  </p>

                  <span className="role-button">Generate with AI →</span>
                </button>

                <button
                  className="role-card"
                  onClick={() => setCreationMode("manual")}
                >
                  <div className="role-icon">✍️</div>

                  <h2>Add MCQs Manually</h2>

                  <p>
                    Write your own questions, options, correct answers and
                    difficulty.
                  </p>

                  <span className="role-button">Add Manually →</span>
                </button>
              </div>
            </div>
          )}

          {/* =================================================
              AI QUIZ BUILDER
          ================================================= */}

          {!quiz && creationMode === "ai" && (
            <div className="review-section">
              <button
                className="secondary-button"
                onClick={() => setCreationMode(null)}
              >
                ← Choose Another Method
              </button>

              <div className="page-heading">
                <span className="eyebrow">AI QUIZ BUILDER</span>

                <h1>Generate MCQs with AI</h1>

                <p>
                  Upload your study material and let AI create the questions
                  automatically.
                </p>
              </div>

              <div className="quiz-builder">
                {/* PDF */}

                <div className="upload-section">
                  <label className="upload-box">
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={(e) => setFile(e.target.files[0])}
                    />

                    <div className="upload-icon">↑</div>

                    <h3>{file ? file.name : "Upload your PDF"}</h3>

                    <p>Click here to select a PDF</p>
                  </label>
                </div>

                {/* SETTINGS */}

                <div className="settings-section">
                  <div className="setting">
                    <label>Number of Questions</label>

                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={numberOfQuestions}
                      onChange={(e) =>
                        setNumberOfQuestions(Number(e.target.value))
                      }
                    />
                  </div>

                  <div className="setting">
                    <label>Marks per Question</label>

                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={marksPerQuestion}
                      onChange={(e) =>
                        setMarksPerQuestion(Number(e.target.value))
                      }
                    />
                  </div>

                  <div className="setting">
                    <label>Quiz Difficulty</label>

                    <select
                      value={difficulty}
                      onChange={(e) => setDifficulty(e.target.value)}
                      className="difficulty-select"
                    >
                      <option value="easy">Easy</option>

                      <option value="moderate">Moderate</option>

                      <option value="hard">Hard</option>
                    </select>
                  </div>

                  {/* =================================================
                      CUSTOM TIMER
                  ================================================= */}

                  <div className="setting">
                    <label>Quiz Time Limit (Minutes)</label>

                    <input
                      type="number"
                      min="1"
                      max="180"
                      value={timeLimit}
                      onChange={(e) => {
                        const value = Number(e.target.value);

                        if (value >= 1 && value <= 180) {
                          setTimeLimit(value);
                        }
                      }}
                    />

                    <small
                      style={{
                        display: "block",
                        marginTop: "6px",
                        opacity: 0.7,
                      }}
                    >
                      Students will have {timeLimit} minute
                      {timeLimit !== 1 ? "s" : ""} to complete this quiz.
                    </small>
                  </div>

                  <div className="total-marks">
                    <span>Total Marks</span>

                    <strong>
                      {Number(numberOfQuestions) * Number(marksPerQuestion)}
                    </strong>
                  </div>

                  <button
                    className="primary-button"
                    onClick={generateQuiz}
                    disabled={loading}
                  >
                    {loading ? "Generating with AI..." : "Generate Quiz ✨"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* =================================================
              MANUAL QUIZ BUILDER
          ================================================= */}

          {!quiz && creationMode === "manual" && (
            <div className="review-section">
              <button
                className="secondary-button"
                onClick={() => setCreationMode(null)}
              >
                ← Choose Another Method
              </button>

              <div className="page-heading">
                <span className="eyebrow">MANUAL QUIZ BUILDER</span>

                <h1>Add MCQs Manually</h1>

                <p>
                  Create your own questions and build the quiz exactly the way
                  you want.
                </p>
              </div>

              {/* CUSTOM TIMER */}

              <div
                className="question-card"
                style={{
                  marginBottom: "24px",
                }}
              >
                <div className="setting">
                  <label>Quiz Time Limit (Minutes)</label>

                  <input
                    type="number"
                    min="1"
                    max="180"
                    value={timeLimit}
                    onChange={(e) => {
                      const value = Number(e.target.value);

                      if (value >= 1 && value <= 180) {
                        setTimeLimit(value);
                      }
                    }}
                  />

                  <small
                    style={{
                      display: "block",
                      marginTop: "6px",
                      opacity: 0.7,
                    }}
                  >
                    Students will have {timeLimit} minute
                    {timeLimit !== 1 ? "s" : ""} to complete this quiz.
                  </small>
                </div>
              </div>

              {/* QUESTION BUILDER */}

              <div className="question-card">
                <div className="question-header">
                  <div className="question-number">
                    Q{manualQuestions.length + 1}
                  </div>

                  <select
                    className="question-difficulty"
                    value={manualDifficulty}
                    onChange={(e) => setManualDifficulty(e.target.value)}
                  >
                    <option value="easy">Easy</option>

                    <option value="moderate">Moderate</option>

                    <option value="hard">Hard</option>
                  </select>
                </div>

                {/* QUESTION */}

                <div className="setting">
                  <label>Question</label>

                  <textarea
                    className="student-input"
                    rows="4"
                    placeholder="Enter your question..."
                    value={manualQuestion}
                    onChange={(e) => setManualQuestion(e.target.value)}
                  />
                </div>

                {/* OPTIONS */}

                <label>Options</label>

                <div className="options">
                  {manualOptions.map((option, index) => (
                    <div className="option" key={index}>
                      <input
                        type="radio"
                        name="manualCorrectAnswer"
                        checked={manualCorrectAnswer === index}
                        onChange={() => setManualCorrectAnswer(index)}
                      />

                      <span>{String.fromCharCode(65 + index)}</span>

                      <input
                        className="student-input"
                        style={{
                          margin: 0,
                        }}
                        placeholder={`Option ${String.fromCharCode(
                          65 + index,
                        )}`}
                        value={option}
                        onChange={(e) =>
                          updateManualOption(index, e.target.value)
                        }
                      />
                    </div>
                  ))}
                </div>

                <p
                  style={{
                    marginTop: "12px",
                    color: "#cfc1df",
                    fontSize: "0.9rem",
                  }}
                >
                  Select the radio button beside the correct answer.
                </p>

                {/* MARKS */}

                <div
                  className="setting"
                  style={{
                    marginTop: "20px",
                  }}
                >
                  <label>Marks</label>

                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={manualMarks}
                    onChange={(e) => setManualMarks(Number(e.target.value))}
                  />
                </div>

                {/* EXPLANATION */}

                <div
                  className="setting"
                  style={{
                    marginTop: "20px",
                  }}
                >
                  <label>
                    Explanation
                    <span
                      style={{
                        opacity: 0.6,
                        fontWeight: 400,
                      }}
                    >
                      {" "}
                      (Optional)
                    </span>
                  </label>

                  <textarea
                    className="student-input"
                    rows="3"
                    placeholder="Explain why the selected answer is correct..."
                    value={manualExplanation}
                    onChange={(e) => setManualExplanation(e.target.value)}
                  />
                </div>

                {/* ADD */}

                <button
                  className="primary-button"
                  onClick={addManualQuestion}
                  style={{
                    marginTop: "20px",
                  }}
                >
                  + Add Question
                </button>
              </div>

              {/* ADDED QUESTIONS */}

              {manualQuestions.length > 0 && (
                <div
                  className="questions-list"
                  style={{
                    marginTop: "30px",
                  }}
                >
                  <div className="page-heading">
                    <span className="eyebrow">QUESTION LIST</span>

                    <h2>Added Questions</h2>

                    <p>
                      {manualQuestions.length} question
                      {manualQuestions.length !== 1 ? "s" : ""} ready.
                    </p>
                  </div>

                  {manualQuestions.map((question, index) => (
                    <div className="question-card" key={question.id}>
                      <div className="question-header">
                        <div className="question-number">Q{index + 1}</div>

                        <span
                          style={{
                            color: "#d8bfff",
                            fontWeight: 700,
                            textTransform: "capitalize",
                          }}
                        >
                          {question.difficulty}
                        </span>
                      </div>

                      <h3>{question.question}</h3>

                      <div className="options">
                        {question.options.map((option, optionIndex) => (
                          <div
                            className={
                              optionIndex === question.correctAnswer
                                ? "option correct"
                                : "option"
                            }
                            key={optionIndex}
                          >
                            <span>{String.fromCharCode(65 + optionIndex)}</span>

                            {option}

                            {optionIndex === question.correctAnswer && <b>✓</b>}
                          </div>
                        ))}
                      </div>

                      <button
                        className="exclude-button"
                        onClick={() => removeManualDraft(question.id)}
                        style={{
                          marginTop: "18px",
                        }}
                      >
                        ✕ Remove
                      </button>
                    </div>
                  ))}

                  <div className="publish-area">
                    <button
                      className="primary-button publish-button"
                      onClick={createManualQuiz}
                    >
                      Continue to Review →
                    </button>

                    <p>
                      All added questions will enter the same review screen as
                      AI-generated questions.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =================================================
              GENERATED / MANUAL QUIZ REVIEW
          ================================================= */}

          {quiz && !published && (
            <div className="review-section">
              <div className="page-heading">
                <span className="eyebrow">
                  {quiz.questions.some((q) => q.source === "manual")
                    ? "QUIZ REVIEW"
                    : "AI GENERATED"}
                </span>

                <h1>Review your quiz</h1>

                <p>
                  Keep, remove or regenerate individual questions before
                  publishing.
                </p>
              </div>

              {/* TIMER SUMMARY */}

              <div
                className="quiz-summary"
                style={{
                  marginBottom: "20px",
                }}
              >
                <div>
                  <span>Quiz Time</span>

                  <strong>{quiz.timeLimit || timeLimit} min</strong>
                </div>

                <div>
                  <span>Active Questions</span>

                  <strong>{getActiveQuestions().length}</strong>
                </div>

                <div>
                  <span>Total Marks</span>

                  <strong>{getCurrentTotalMarks()}</strong>
                </div>
              </div>

              {/* SUMMARY */}

              <div className="quiz-summary">
                <div>
                  <span>Active Questions</span>

                  <strong>{getActiveQuestions().length}</strong>
                </div>

                <div>
                  <span>Total Questions</span>

                  <strong>{quiz.questions.length}</strong>
                </div>

                <div>
                  <span>Total Marks</span>

                  <strong>{getCurrentTotalMarks()}</strong>
                </div>
              </div>

              {/* QUESTIONS */}

              <div className="questions-list">
                {quiz.questions.map((q, index) => (
                  <div
                    className={
                      q.excluded
                        ? "question-card excluded-question"
                        : "question-card"
                    }
                    key={q.id}
                  >
                    <div className="question-header">
                      <div className="question-number">Q{index + 1}</div>

                      {!q.excluded && (
                        <select
                          className="question-difficulty"
                          value={q.difficulty || "moderate"}
                          onChange={(e) =>
                            changeDifficulty(q.id, e.target.value)
                          }
                        >
                          <option value="easy">Easy</option>

                          <option value="moderate">Moderate</option>

                          <option value="hard">Hard</option>
                        </select>
                      )}
                    </div>

                    {q.excluded ? (
                      <div className="excluded-content">
                        <div className="excluded-icon">✕</div>

                        <h3>Question excluded</h3>

                        <p>
                          This question won't be included in the final quiz.
                        </p>

                        <button
                          className="secondary-button"
                          onClick={() => restoreQuestion(q.id)}
                        >
                          ↶ Undo
                        </button>
                      </div>
                    ) : (
                      <>
                        <h3>{q.question}</h3>

                        <div className="options">
                          {(q.options || []).map((option, optionIndex) => (
                            <div
                              className={
                                optionIndex === q.correctAnswer
                                  ? "option correct"
                                  : "option"
                              }
                              key={`${q.id}-${optionIndex}`}
                            >
                              <span>
                                {String.fromCharCode(65 + optionIndex)}
                              </span>

                              {option}

                              {optionIndex === q.correctAnswer && <b>✓</b>}
                            </div>
                          ))}
                        </div>

                        {q.explanation && (
                          <div className="explanation">
                            <strong>
                              {q.source === "manual"
                                ? "Explanation:"
                                : "AI Explanation:"}
                            </strong>

                            <p>{q.explanation}</p>
                          </div>
                        )}

                        <div className="question-actions">
                          {q.source !== "manual" && (
                            <button
                              className="regenerate-button"
                              onClick={() => regenerateQuestion(q.id)}
                              disabled={regeneratingQuestion === q.id}
                            >
                              {regeneratingQuestion === q.id
                                ? "⟳ Generating..."
                                : "↻ Regenerate"}
                            </button>
                          )}

                          <button
                            className="exclude-button"
                            onClick={() => excludeQuestion(q.id)}
                          >
                            ✕ Exclude
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* PUBLISH */}

              <div className="publish-area">
                <button
                  className="primary-button publish-button"
                  onClick={publishQuiz}
                >
                  Publish Quiz 🚀
                </button>

                <p>
                  Quiz timer:{" "}
                  <strong>{quiz.timeLimit || timeLimit} minutes</strong>
                </p>

                <p>
                  Only active questions will be included in the published quiz.
                </p>
              </div>
            </div>
          )}

          {/* =================================================
              PUBLISHED QUIZ
          ================================================= */}

          {quiz && published && (
            <div className="published-section">
              <div className="page-heading">
                <span className="eyebrow">QUIZ PUBLISHED</span>

                <h1>Your quiz is live!</h1>

                <p>Share the QR code or quiz code with your students.</p>
              </div>

              <div className="publish-grid">
                <div className="qr-card">
                  <div className="qr-wrapper">
                    <QRCodeCanvas
                      value={`${window.location.origin}/join/${quizCode}`}
                      size={240}
                      bgColor="#ffffff"
                      fgColor="#24103f"
                      level="H"
                    />
                  </div>

                  <p>Students can scan this QR code with their phone.</p>
                </div>

                <div className="code-card">
                  <span>QUIZ CODE</span>

                  <strong>{quizCode}</strong>

                  <p>Students sitting far away can simply enter this code.</p>

                  <button
                    className="secondary-button"
                    onClick={() => navigator.clipboard.writeText(quizCode)}
                  >
                    Copy Code
                  </button>
                </div>
              </div>

              {/* TIMER INFORMATION */}

              <div
                className="live-info"
                style={{
                  marginTop: "20px",
                }}
              >
                <span>⏱ Quiz Time Limit</span>

                <p>
                  Students have{" "}
                  <strong>{quiz.timeLimit || timeLimit} minutes</strong> to
                  complete this quiz.
                </p>
              </div>

              <div className="live-info">
                <span>● Quiz is Live</span>

                <p>
                  {studentCount === 0
                    ? "Waiting for students to join..."
                    : `${studentCount} student${
                        studentCount === 1 ? "" : "s"
                      } joined the quiz.`}
                </p>
              </div>

              <div
                className="quiz-summary"
                style={{
                  marginTop: "20px",
                }}
              >
                <div>
                  <span>Students Joined</span>

                  <strong>{studentCount}</strong>
                </div>

                <div>
                  <span>Time Limit</span>

                  <strong>{quiz.timeLimit || timeLimit} min</strong>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  // =========================================================
  // STUDENT RESULT
  // =========================================================

  if (role === "student" && studentResult) {
    return (
      <div className="app">
        <div className="student-container">
          <div className="student-card">
            <div className="student-icon">🎉</div>

            <span className="eyebrow">QUIZ COMPLETED</span>

            <h1>Quiz Submitted Successfully</h1>

            <p>
              {studentName} • {enrollment}
            </p>

            <div
              className="quiz-summary"
              style={{
                marginTop: "30px",
              }}
            >
              <div>
                <span>Score</span>

                <strong>{studentResult.score}</strong>
              </div>

              <div>
                <span>Total Marks</span>

                <strong>{studentResult.totalMarks}</strong>
              </div>

              <div>
                <span>Percentage</span>

                <strong>{studentResult.percentage}%</strong>
              </div>
            </div>

            <div
              className="questions-list"
              style={{
                marginTop: "30px",
              }}
            >
              <h2>Review Answers</h2>

              {studentResult.review?.map((item, index) => (
                <div className="question-card" key={index}>
                  <h3>
                    Q{index + 1}. {item.question}
                  </h3>

                  <div className="options">
                    {item.options.map((option, optionIndex) => {
                      const isCorrect = optionIndex === item.correctAnswer;

                      const isSelected = optionIndex === item.studentAnswer;

                      return (
                        <div
                          key={optionIndex}
                          className={isCorrect ? "option correct" : "option"}
                        >
                          <span>{String.fromCharCode(65 + optionIndex)}</span>

                          <span>{option}</span>

                          {isCorrect && <b>✓ Correct Answer</b>}

                          {isSelected && !isCorrect && <b>✕ Your Answer</b>}
                        </div>
                      );
                    })}
                  </div>

                  {item.explanation && (
                    <div className="explanation">
                      <strong>Explanation</strong>

                      <p>{item.explanation}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button
              className="primary-button"
              style={{
                marginTop: "30px",
              }}
              onClick={goHome}
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================
  // STUDENT ACTIVE QUIZ
  // =========================================================

  if (role === "student" && quizStarted && studentQuiz) {
    const q = studentQuiz.questions[currentQuestion];

    const isLastQuestion = currentQuestion === studentQuiz.questions.length - 1;

    const timerIsCritical = timeLeft <= 60;

    return (
      <div className="app">
        <div className="student-container student-exam">
          <div className="student-card">
            {/* HEADER */}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "20px",
                marginBottom: "20px",
              }}
            >
              <div>
                <h1>{studentQuiz.title || "Advance's Quiz"}</h1>

                <p>
                  Question {currentQuestion + 1} of{" "}
                  {studentQuiz.questions.length}
                </p>
              </div>

              {/* SINGLE TIMER */}

              <div
                style={{
                  padding: "12px 18px",
                  borderRadius: "12px",
                  background: timerIsCritical ? "#7f1d1d" : "#24103f",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: "20px",
                  minWidth: "110px",
                  textAlign: "center",
                  boxShadow: timerIsCritical
                    ? "0 0 20px rgba(220,38,38,0.45)"
                    : "none",
                }}
              >
                ⏱ {formatTime(timeLeft)}
              </div>
            </div>

            {/* TIMER WARNING */}

            {timeLeft <= 60 && timeLeft > 0 && (
              <div
                style={{
                  padding: "10px 14px",
                  marginBottom: "20px",
                  borderRadius: "10px",
                  background: "#450a0a",
                  color: "#fecaca",
                  textAlign: "center",
                  fontWeight: 700,
                }}
              >
                ⚠️ Less than one minute remaining!
              </div>
            )}

            {/* QUESTION */}

            <div className="question-card">
              <h3>{q.question}</h3>

              <div className="options">
                {q.options.map((option, index) => (
                  <label key={index} className="option">
                    <input
                      type="radio"
                      name={`question-${currentQuestion}`}
                      checked={studentAnswers[currentQuestion] === index}
                      onChange={() =>
                        setStudentAnswers((previous) => ({
                          ...previous,
                          [currentQuestion]: index,
                        }))
                      }
                    />

                    <span>{String.fromCharCode(65 + index)}</span>

                    <span>{option}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* NAVIGATION */}

            <div className="question-actions">
              <button
                className="secondary-button"
                disabled={currentQuestion === 0 || submittingQuiz}
                onClick={() => setCurrentQuestion(currentQuestion - 1)}
              >
                ← Previous
              </button>

              {!isLastQuestion ? (
                <button
                  className="primary-button"
                  disabled={submittingQuiz}
                  onClick={() => setCurrentQuestion(currentQuestion + 1)}
                >
                  Next →
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={submittingQuiz}
                  onClick={() => submitQuiz(false)}
                >
                  {submittingQuiz ? "Submitting..." : "Submit Quiz"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================
  // STUDENT JOIN PANEL
  // =========================================================

  return (
    <div className="app">
      <div className="topbar">
        <button onClick={goHome} className="back-button">
          ← Home
        </button>

        <h2>
          Advance's <span>Quiz</span>
        </h2>
      </div>

      <main className="student-container">
        <div className="student-card">
          <div className="student-icon">🎓</div>

          <span className="eyebrow">STUDENT</span>

          <h1>Join a Quiz</h1>

          <p>Enter the code shared by your teacher.</p>

          <input
            className="student-input"
            placeholder="Your Name"
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
          />

          <input
            className="student-input"
            placeholder="Enrollment Number"
            value={enrollment}
            onChange={(e) => setEnrollment(e.target.value)}
          />

          <input
            className="student-input code-input"
            placeholder="STXXXXXXX"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />

          <button
            className="primary-button"
            onClick={async () => {
              if (
                !studentName.trim() ||
                !enrollment.trim() ||
                !joinCode.trim()
              ) {
                alert("Please fill all fields.");
                return;
              }

              try {
                const code = joinCode.trim().toUpperCase();

                // =================================================
                // START STUDENT ATTEMPT
                // =================================================

                const joinResponse = await axios.post(
                  `https://advancequiz.onrender.com/quiz/${code}/join`,
                  {
                    studentName: studentName.trim(),

                    enrollment: enrollment.trim().toUpperCase(),
                  },
                );

                if (!joinResponse.data.success) {
                  throw new Error(
                    joinResponse.data.error || "Failed to join quiz.",
                  );
                }

                // =================================================
                // LOAD QUIZ
                // =================================================

                const quizResponse = await axios.get(
                  `https://advancequiz.onrender.com/quiz/${code}`,
                );

                const loadedQuiz = quizResponse.data.quiz;

                // =================================================
                // SAVE QUIZ
                // =================================================

                setStudentQuiz(loadedQuiz);

                setStudentAnswers({});

                setCurrentQuestion(0);

                setStudentResult(null);

                setSubmittingQuiz(false);

                // =================================================
                // SERVER-CONTROLLED TIMER
                // =================================================

                if (!joinResponse.data.student?.expiresAt) {
                  throw new Error(
                    "The server did not provide a quiz expiration time.",
                  );
                }

                const expiresAt = new Date(
                  joinResponse.data.student.expiresAt,
                ).getTime();

                const now = Date.now();

                const remainingSeconds = Math.max(
                  0,
                  Math.ceil((expiresAt - now) / 1000),
                );

                console.log(
                  "SERVER QUIZ EXPIRATION:",
                  new Date(expiresAt).toLocaleString(),
                );

                console.log("REMAINING SECONDS:", remainingSeconds);

                setTimeLeft(remainingSeconds);

                setQuizStarted(true);
              } catch (error) {
                console.error("JOIN QUIZ ERROR:", error);

                alert(
                  error.response?.data?.error ||
                    error.message ||
                    "Failed to join quiz.",
                );
              }
            }}
          >
            Join Quiz →
          </button>

          <div className="scan-info">
            <span>📱</span>

            <p>
              Have the QR code?
              <br />
              Simply scan it with your phone.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;

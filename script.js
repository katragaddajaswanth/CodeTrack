const pages = [...document.querySelectorAll(".page")];
const navItems = [...document.querySelectorAll("[data-page]")];
const pageLabel = document.querySelector("#page-label");
const sidebar = document.querySelector(".sidebar");
const toast = document.querySelector("#toast");
const themeToggle = document.querySelector("#theme-toggle");
const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const authForm = document.querySelector("#auth-form");
const authSwitch = document.querySelector("#auth-switch");
const authGuest = document.querySelector("#auth-guest");
const authError = document.querySelector("#auth-error");

// Local dev (Live Server or file://) talks to the Flask backend on port 5000;
// deployed environments talk to the same-origin /api routes served by the backend.
const backendHost = window.location.hostname || "127.0.0.1";
const isLocalDev = !window.location.hostname || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(backendHost);
const backendProtocol = window.location.protocol === "https:" ? "https:" : "http:";
const API_BASE = isLocalDev ? `${backendProtocol}//${backendHost}:5000/api` : "/api";
const AUTH_API = `${API_BASE}/auth`;
const LEETCODE_API = `${API_BASE}/leetcode`;

let authMode = "signin";
let activeUserId = localStorage.getItem("codetrack-active-user");
let authenticatedUser = null;
const publicSnapshot = location.hash.startsWith("#public=") ? JSON.parse(decodeURIComponent(location.hash.slice(8))) : null;

const defaultProfile = {
  name: "Developer",
  role: "CS student",
  github: "",
  linkedin: "",
  leetcode: "",
  email: "",
  description: "Building consistent problem-solving habits one day at a time.",
  course: "Computer Science",
  location: "",
  skills: "Python, C++, C, Web development"
};

const defaultGoals = [
  { id: "leetcode", title: "LeetCode problem goal", category: "Algorithms", target: 500, completed: 0, notify: true, tone: "ring-green" },
  { id: "goal-portfolio", title: "Build a portfolio project", category: "Projects", target: 1, completed: 0, notify: false, tone: "ring-blue" },
  { id: "goal-sql", title: "SQL fundamentals", category: "Learning", target: 50, completed: 0, notify: false, tone: "ring-yellow" },
];

let sessionState = [];
let profileState = { ...defaultProfile };
let remoteProblems = [];
let leetcodeStats = null;
let goalState = defaultGoals.map((g) => ({ ...g }));
let statsRange = "all";
let activityRange = "month";
let leetcodeSyncRequest = null;
let lastLeetCodeSync = 0;

function userStorageKey(key) {
  const userKey = activeUserId || "guest";
  return `codetrack:${userKey}:${key}`;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.querySelector("#auth-title").innerHTML = signup ? "Create your account<span class=\"accent-dot\">.</span>" : "Welcome back<span class=\"accent-dot\">.</span>";
  document.querySelector("#auth-copy").textContent = signup ? "Set up a personal coding workspace." : "Sign in to continue tracking your progress.";
  document.querySelector(".signup-field").classList.toggle("hidden", !signup);
  document.querySelector("#auth-submit").textContent = signup ? "Create account" : "Sign in";
  authSwitch.textContent = signup ? "Already have an account? Sign in" : "Create a new account";
  document.querySelector("#auth-password").autocomplete = signup ? "new-password" : "current-password";
  authError.textContent = "";
}

function showAuth() {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
}

function setAuthenticatedUser(user) {
  authenticatedUser = user;
  activeUserId = user.email || "guest";
  localStorage.setItem("codetrack-active-user", activeUserId);
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  loadUserData();
}

function loginAsGuest() {
  authenticatedUser = { name: "Guest Developer", email: "guest@codetrack.local" };
  activeUserId = "guest";
  localStorage.setItem("codetrack-active-user", "guest");
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  loadUserData();
  showToast("Welcome! Exploring in guest mode.");
}

async function authRequest(endpoint, payload) {
  let response;
  try {
    response = await fetch(`${AUTH_API}/${endpoint}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error("Cannot reach the backend server (127.0.0.1:5000). Start backend/app.py or continue as guest.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Authentication request failed.");
  return result;
}

async function requestPasswordReset(email) {
  let response;
  try {
    response = await fetch(`${AUTH_API}/forgot-password`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
  } catch {
    throw new Error("Cannot reach the backend server. Make sure backend/app.py is running.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Password reset request failed.");
  return result;
}

async function resetPassword(token, password) {
  let response;
  try {
    response = await fetch(`${AUTH_API}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password })
    });
  } catch {
    throw new Error("Cannot reach the backend server. Make sure backend/app.py is running.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Password reset failed.");
  return result;
}

function openResetModal(token) {
  createModal("Choose a new password", `<form class="modal-form"><label>New password<input name="password" type="password" minlength="6" required autocomplete="new-password" placeholder="At least 6 characters"></label><button class="primary-button modal-submit" type="submit">Update password</button></form>`, async (formData) => {
    try {
      const result = await resetPassword(token, formData.get("password"));
      showToast(result.message);
      history.replaceState({}, "", window.location.pathname);
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function accountRequest(payload) {
  let response;
  try {
    response = await fetch(`${AUTH_API}/account`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error("Cannot reach the server to update account.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Account update failed.");
  return result;
}

async function restoreSession() {
  if (publicSnapshot) {
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
    document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));
    const publicPage = document.createElement("section");
    publicPage.className = "page public-profile-page";
    publicPage.innerHTML = `<section class="page-intro compact-intro"><div><p class="kicker">Public profile</p><h1>${publicSnapshot.name || "Coder"}<span class="accent-dot">.</span></h1><p class="intro-copy">${publicSnapshot.role || "Student developer"}</p></div></section><section class="profile-hero panel"><div class="large-avatar">${initialsFor(publicSnapshot.name || "Coder")}</div><div><h2>${publicSnapshot.name || "Coder"}</h2><p>${publicSnapshot.description || "A CODETRACK learner."}</p><div class="profile-links">${["github", "linkedin", "leetcode"].filter((key) => publicSnapshot[key]).map((key) => `<a href="${publicSnapshot[key]}" target="_blank" rel="noopener">${key} ↗</a>`).join("")}</div></div></section><section class="stats-metrics"><article class="panel"><span>Problems solved</span><strong>${publicSnapshot.total || 0}</strong></article><article class="panel"><span>Current streak</span><strong>${publicSnapshot.streak || 0} days</strong></article><article class="panel"><span>Languages</span><strong>${publicSnapshot.skills || "Not added"}</strong></article></section>`;
    appShell.querySelector(".main-content").appendChild(publicPage);
    return;
  }

  if (!activeUserId) {
    return showAuth();
  }

  if (activeUserId === "guest") {
    loginAsGuest();
    return;
  }

  try {
    const response = await fetch(`${AUTH_API}/me`, { credentials: "include" });
    if (!response.ok) throw new Error("Session expired.");
    const result = await response.json();
    setAuthenticatedUser(result.user);
  } catch {
    // If backend is temporarily offline, use locally cached profile if available
    const cachedProfile = JSON.parse(localStorage.getItem(userStorageKey("profile")) || "{}");
    if (cachedProfile && cachedProfile.name) {
      authenticatedUser = { name: cachedProfile.name, email: activeUserId };
      authScreen.classList.add("hidden");
      appShell.classList.remove("hidden");
      loadUserData();
      showToast("Offline mode: using saved local session.");
    } else {
      activeUserId = null;
      localStorage.removeItem("codetrack-active-user");
      showAuth();
    }
  }
}

function loadUserData() {
  const savedProfile = JSON.parse(localStorage.getItem(userStorageKey("profile")) || "{}");
  const accountInfo = authenticatedUser ? { name: authenticatedUser.name, email: authenticatedUser.email } : {};
  Object.assign(profileState, defaultProfile, savedProfile, accountInfo);

  const storedSessions = JSON.parse(localStorage.getItem(userStorageKey("sessions")) || "null");
  if (Array.isArray(storedSessions)) {
    // Flatten in case an older save nested the whole session list, and drop invalid entries
    const flatSessions = storedSessions.flat().filter((session) => session && typeof session === "object" && !Array.isArray(session));
    sessionState.splice(0, sessionState.length, ...flatSessions);
  } else {
    // Provide starter sample sessions for new users if storage is completely empty
    sessionState.splice(0, sessionState.length,
      { name: "Two Sum", topic: "Arrays", difficulty: "Easy", language: "Python", time: "24 min", timestamp: Date.now() - 3600000, date: "Today, 9:42 AM" },
      { name: "Valid Parentheses", topic: "Stack", difficulty: "Medium", language: "Python", time: "38 min", timestamp: Date.now() - 86400000, date: "Yesterday" },
      { name: "Best Time to Buy Stock", topic: "Greedy", difficulty: "Easy", language: "C++", time: "19 min", timestamp: Date.now() - 172800000, date: "2 days ago" }
    );
    localStorage.setItem(userStorageKey("sessions"), JSON.stringify(sessionState));
  }

  const storedGoals = JSON.parse(localStorage.getItem(userStorageKey("goals")) || "null");
  goalState = (storedGoals && Array.isArray(storedGoals) && storedGoals.length) ? storedGoals : defaultGoals.map((g) => ({ ...g }));

  leetcodeStats = JSON.parse(localStorage.getItem(userStorageKey("stats")) || "null");
  remoteProblems = JSON.parse(localStorage.getItem(userStorageKey("remote-problems")) || "[]");

  const savedTheme = localStorage.getItem(userStorageKey("theme"));
  applyTheme(savedTheme || "light");

  updateGreetingAndDate();
  renderProfile();
  renderSessions();
  renderGoals(leetcodeStats?.total || 0);
  renderProblems();
  updateDashboardStats();
  renderActivity();
  renderActivityTimeline();
  renderCachedLanguageUsage();
  renderActivitySummary();
  loadGithubStats();
  renderMonthCalendar();
  renderStreakDots();
  updateSidebarMiniProgress();
}

authSwitch?.addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
authGuest?.addEventListener("click", loginAsGuest);

document.querySelector("#forgot-password")?.addEventListener("click", () => {
  createModal("Reset your password", `<form class="modal-form"><label>Email address<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label><p class="auth-copy">We will send reset instructions if an account exists for this email.</p><button class="primary-button modal-submit" type="submit">Request reset link</button></form>`, async (formData) => {
    try {
      const result = await requestPasswordReset(formData.get("email").trim().toLowerCase());
      showToast(result.message);
    } catch (error) {
      showToast(error.message);
    }
  });
});

authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#auth-email").value.trim().toLowerCase();
  const password = document.querySelector("#auth-password").value;
  const name = document.querySelector("#auth-name").value.trim();
  try {
    const result = await authRequest(authMode === "signup" ? "signup" : "login", { email, password, name });
    if (authMode === "signup" && !localStorage.getItem(`codetrack:${email}:profile`)) {
      localStorage.setItem(`codetrack:${email}:profile`, JSON.stringify({ name: result.user.name, email: result.user.email }));
    }
    setAuthenticatedUser(result.user);
  } catch (error) {
    authError.textContent = error.message;
  }
});

document.querySelector("#logout-button")?.addEventListener("click", async () => {
  await fetch(`${AUTH_API}/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  localStorage.removeItem("codetrack-active-user");
  authenticatedUser = null;
  activeUserId = null;
  showAuth();
  showToast("Logged out successfully.");
});

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toast._timeout);
  toast._timeout = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function downloadFile(filename, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportBackup(format) {
  const data = { profile: profileState, sessions: sessionState, goals: goalState, stats: leetcodeStats, problems: remoteProblems };
  if (format === "json") downloadFile("codetrack-backup.json", JSON.stringify(data, null, 2), "application/json");
  else {
    const rows = [["Problem", "Topic", "Difficulty", "Language", "Date"], ...trackedProblems().map((item) => [item.name, item.topic, item.difficulty, item.language, item.date])];
    downloadFile("codetrack-problems.csv", rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"), "text/csv");
  }
  showToast("Export downloaded.");
}

function restoreBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.profile) Object.assign(profileState, data.profile);
      if (Array.isArray(data.sessions)) { sessionState.splice(0, sessionState.length, ...data.sessions); localStorage.setItem(userStorageKey("sessions"), JSON.stringify(sessionState)); }
      if (Array.isArray(data.goals)) { goalState = data.goals; localStorage.setItem(userStorageKey("goals"), JSON.stringify(goalState)); }
      if (data.stats) { leetcodeStats = data.stats; localStorage.setItem(userStorageKey("stats"), JSON.stringify(leetcodeStats)); }
      if (Array.isArray(data.problems)) { remoteProblems = data.problems; localStorage.setItem(userStorageKey("remote-problems"), JSON.stringify(remoteProblems)); }
      localStorage.setItem(userStorageKey("profile"), JSON.stringify(profileState));
      renderProfile(); renderSessions(); renderGoals(leetcodeStats?.total || 0); renderProblems(); updateDashboardStats();
      showToast("Backup restored.");
    } catch { showToast("That backup file is not valid."); }
  };
  reader.readAsText(file);
}

function trackedProblems() {
  const loggedProblems = sessionState
    .filter((session) => session && typeof session === "object")
    .map((session) => ({
      name: session.name,
      topic: session.topic || "Logged session",
      difficulty: session.difficulty || "Easy",
      language: session.language || "Unknown",
      timestamp: session.timestamp || 0,
      date: session.date || formatSessionDate(session.timestamp),
      source: "local"
    }));
  const safeProblems = [...remoteProblems, ...loggedProblems]
    .filter((problem) => problem && typeof problem === "object")
    .map((problem) => ({
      ...problem,
      name: String(problem.name ?? "").trim(),
      topic: problem.topic || "Logged session",
      difficulty: problem.difficulty || "Easy",
      language: problem.language || "Unknown",
      timestamp: problem.timestamp || 0,
      date: problem.date || formatSessionDate(problem.timestamp)
    }))
    .filter((problem) => problem.name);
  return safeProblems.filter((problem, index, list) => list.findIndex((item) => item.name.toLowerCase() === problem.name.toLowerCase()) === index);
}

function createModal(title, content, onSubmit) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="modal-close" type="button" aria-label="Close dialog">×</button><p class="kicker">CODETRACK</p><h2 id="modal-title">${title}</h2>${content}</section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector(".modal-close").addEventListener("click", close);
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  modal.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (onSubmit) onSubmit(new FormData(event.currentTarget));
    close();
  });
  modal.querySelector("input")?.focus();
  modal.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
}

function initialsFor(name) {
  if (!name || typeof name !== "string") return "JK";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "JK";
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

function formatSessionDate(timestamp) {
  if (!timestamp) return "Recent";
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `Today, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function updateGreetingAndDate() {
  const dateElement = document.querySelector("#overview-date");
  if (dateElement) {
    const today = new Date();
    dateElement.textContent = today.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }
  const greetingElement = document.querySelector("#overview-greeting");
  if (greetingElement) {
    const hour = new Date().getHours();
    greetingElement.textContent = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  }
}

function renderProfile() {
  const profileCard = document.querySelector("#profile-card");
  if (!profileCard) return;
  const sidebarAvatar = profileCard.querySelector(".avatar");
  sidebarAvatar.textContent = initialsFor(profileState.name);
  sidebarAvatar.style.backgroundImage = profileState.photo ? `url(${profileState.photo})` : "";
  sidebarAvatar.classList.toggle("has-photo", Boolean(profileState.photo));
  profileCard.querySelector("strong").textContent = profileState.name;
  profileCard.querySelector("span:not(.icon-button)").textContent = profileState.role;
  const dashboardName = document.querySelector("#dashboard-user-name");
  if (dashboardName) dashboardName.textContent = profileState.name || "there";
  const pageName = document.querySelector("#profile-page-name");
  const pageRole = document.querySelector("#profile-page-role");
  const pageAvatar = document.querySelector("#profile-avatar");
  const description = document.querySelector("#profile-description");
  const course = document.querySelector("#profile-course");
  const location = document.querySelector("#profile-location");
  const email = document.querySelector("#profile-email");
  const lastSynced = document.querySelector("#last-synced");
  if (pageName) pageName.textContent = profileState.name;
  if (pageRole) pageRole.textContent = profileState.role;
  if (pageAvatar) pageAvatar.textContent = initialsFor(profileState.name);
  if (description) description.textContent = profileState.description || "No description added yet.";
  if (course) course.textContent = profileState.course || "Not added yet";
  if (location) location.textContent = profileState.location || "Not added yet";
  if (email) email.textContent = profileState.email || "Not added yet";
  if (lastSynced && leetcodeStats?.lastSynced) lastSynced.textContent = `Last synced: ${new Date(leetcodeStats.lastSynced * 1000).toLocaleString()}`;
  const links = document.querySelector("#profile-links");
  if (links) {
    links.innerHTML = "";
    [["GitHub", profileState.github], ["LinkedIn", profileState.linkedin], ["LeetCode", profileState.leetcode], ["Email", profileState.email ? `mailto:${profileState.email}` : ""]].forEach(([label, url]) => {
      if (!url) return;
      const link = document.createElement("a");
      link.href = url;
      link.textContent = `${label} ↗`;
      link.target = label === "Email" ? "_self" : "_blank";
      if (label !== "Email") link.rel = "noopener";
      links.appendChild(link);
    });
  }
  const skills = document.querySelector("#profile-skills");
  if (skills) {
    skills.innerHTML = "";
    profileState.skills.split(",").map((skill) => skill.trim()).filter(Boolean).forEach((skill, index) => {
      const chip = document.createElement("span");
      chip.className = ["chip-python", "chip-cpp", "chip-c", "chip-web"][index % 4];
      chip.textContent = skill;
      skills.appendChild(chip);
    });
  }
  if (profileState.photo && pageAvatar) {
    pageAvatar.style.backgroundImage = `url(${profileState.photo})`;
    pageAvatar.textContent = "";
    pageAvatar.classList.add("has-photo");
  } else if (pageAvatar) {
    pageAvatar.style.backgroundImage = "";
    pageAvatar.classList.remove("has-photo");
  }
}

function renderCachedLanguageUsage() {
  if (leetcodeStats?.languageProblemCount?.length) {
    renderAdvancedStats(trackedProblems(), leetcodeStats);
  }
}

function openProfileModal() {
  createModal("Your details", `<form class="modal-form"><label>Full name<input name="name" required maxlength="60" value="${profileState.name}"></label><label>Role or course<input name="role" required maxlength="60" value="${profileState.role}"></label><div class="form-row"><label>Course<input name="course" maxlength="80" value="${profileState.course}"></label><label>Location<input name="location" maxlength="60" value="${profileState.location}"></label></div><label>Email address<input name="email" type="email" maxlength="120" placeholder="you@example.com" value="${profileState.email}"></label><label>Short description<textarea name="description" rows="3" maxlength="240">${profileState.description}</textarea></label><label>GitHub profile<input name="github" type="url" placeholder="https://github.com/username" value="${profileState.github}"></label><label>LinkedIn profile<input name="linkedin" type="url" placeholder="https://linkedin.com/in/username" value="${profileState.linkedin}"></label><label>LeetCode profile<input name="leetcode" type="url" placeholder="https://leetcode.com/username" value="${profileState.leetcode}"></label><label>Skills <small>separate with commas</small><input name="skills" maxlength="180" value="${profileState.skills}"></label><button class="primary-button modal-submit" type="submit">Save details</button></form>`, (formData) => {
    profileState.name = formData.get("name").trim();
    profileState.role = formData.get("role").trim();
    profileState.course = formData.get("course").trim();
    profileState.location = formData.get("location").trim();
    profileState.email = formData.get("email").trim();
    profileState.description = formData.get("description").trim();
    profileState.github = formData.get("github").trim();
    profileState.linkedin = formData.get("linkedin").trim();
    profileState.leetcode = formData.get("leetcode").trim();
    profileState.skills = formData.get("skills").trim();
    localStorage.setItem(userStorageKey("profile"), JSON.stringify(profileState));
    renderProfile();
    loadGithubStats();
    if (profileState.leetcode) syncLeetCodeProfile(true);
    showToast("Profile details saved.");
  });
}

function getLeetCodeUsername(profileUrl) {
  const rawValue = String(profileUrl || "").trim();
  if (!rawValue || rawValue === "https://leetcode.com/" || rawValue === "https://leetcode.com") return "";
  try {
    const normalizedUrl = rawValue.startsWith("http") ? rawValue : `https://${rawValue}`;
    const parsedUrl = new URL(normalizedUrl);
    if (!parsedUrl.hostname.endsWith("leetcode.com")) return rawValue.replace(/^@/, "");
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const profileIndex = pathParts.findIndex((part) => part.toLowerCase() === "u");
    const username = profileIndex >= 0 ? pathParts[profileIndex + 1] : pathParts[0];
    return username ? decodeURIComponent(username).replace(/^@/, "") : "";
  } catch {
    return rawValue.replace(/^@/, "");
  }
}

function renderLeetCodeStats(profile) {
  const solved = Number(profile.totalSolved ?? profile.total) || 0;
  const easy = Number(profile.easySolved ?? profile.easy) || 0;
  const medium = Number(profile.mediumSolved ?? profile.medium) || 0;
  const hard = Number(profile.hardSolved ?? profile.hard) || 0;
  const solvedElement = document.querySelector("#leetcode-solved");
  const goalPercentElement = document.querySelector("#leetcode-goal-percent");
  const progressElement = document.querySelector("#leetcode-goal-progress");
  if (solvedElement) solvedElement.textContent = solved;
  if (document.querySelector("#leetcode-easy")) document.querySelector("#leetcode-easy").textContent = easy;
  if (document.querySelector("#leetcode-medium")) document.querySelector("#leetcode-medium").textContent = medium;
  if (document.querySelector("#leetcode-hard")) document.querySelector("#leetcode-hard").textContent = hard;
  if (goalPercentElement) goalPercentElement.textContent = `${Math.min(100, Math.round((solved / 500) * 100))}%`;
  if (progressElement) progressElement.style.width = `${Math.min(100, (solved / 500) * 100)}%`;
  const totalSubmissions = Number(profile.totalSubmissions?.find((item) => item.difficulty === "All")?.submissions || 0);
  leetcodeStats = { total: solved, easy, medium, hard, totalSubmissions, acceptedSubmissions: solved, languageProblemCount: profile.languageProblemCount || leetcodeStats?.languageProblemCount || [], submissionCalendar: profile.submissionCalendar || leetcodeStats?.submissionCalendar };
  localStorage.setItem(userStorageKey("stats"), JSON.stringify(leetcodeStats));
  updateStatsPage({ total: solved, easy, medium, hard });
}

function renderLeetCodeSubmissions(submissions) {
  const table = document.querySelector(".session-table");
  const submissionList = Array.isArray(submissions) ? submissions : submissions?.recentSubmissions;
  if (!Array.isArray(submissionList) || !submissionList.length) return;
  remoteProblems = submissionList.filter((submission) => submission.statusDisplay === "Accepted" || !submission.statusDisplay).map((submission) => ({
    name: submission.title || "LeetCode submission",
    topic: "LeetCode",
    difficulty: submission.difficulty || "Easy",
    language: submission.lang || "LeetCode",
    timestamp: submission.timestamp ? Number(submission.timestamp) * 1000 : Date.now(),
    date: submission.timestamp ? formatSessionDate(Number(submission.timestamp) * 1000) : "Recent",
    source: "leetcode"
  }));
  localStorage.setItem(userStorageKey("remote-problems"), JSON.stringify(remoteProblems));
  renderProblems();
  updateStatsPage(leetcodeStats || {});
  if (!table) return;
  table.querySelectorAll(".session-row:not(.table-header)").forEach((row) => row.remove());
  submissionList.slice(0, 5).forEach((submission) => {
    const row = document.createElement("div");
    row.className = "session-row";
    const ts = submission.timestamp ? Number(submission.timestamp) * 1000 : null;
    const dateText = ts ? formatSessionDate(ts) : "Recent";
    row.innerHTML = `<div class="problem-name"><span class="problem-badge easy">✓</span><strong>${submission.title || "LeetCode submission"}</strong></div><span>${submission.lang || "LeetCode"}</span><span class="status-solved">${submission.statusDisplay || "Accepted"}</span><span>Live</span><span>${dateText}</span>`;
    table.appendChild(row);
  });
}

function updateStatsPage(override = {}) {
  const list = trackedProblems();
  const counts = list.reduce((result, problem) => {
    const difficulty = problem.difficulty in result ? problem.difficulty : "Easy";
    result[difficulty] += 1;
    return result;
  }, { Easy: 0, Medium: 0, Hard: 0 });
  const synced = { total: 0, easy: 0, medium: 0, hard: 0, ...leetcodeStats, ...override };
  const total = synced.total || list.length;
  const easy = synced.easy ?? counts.Easy;
  const medium = synced.medium ?? counts.Medium;
  const hard = synced.hard ?? counts.Hard;
  const values = [["#stats-solved", total], ["#stats-total-donut", total], ["#stats-easy", `${easy} solved`], ["#stats-medium", `${medium} solved`], ["#stats-hard", `${hard} solved`]];
  values.forEach(([selector, value]) => { const element = document.querySelector(selector); if (element) element.textContent = value; });

  // Update big-donut background gradient based on actual counts
  const donut = document.querySelector(".big-donut");
  if (donut) {
    const sum = (easy + medium + hard) || 1;
    const easyPct = Math.round((easy / sum) * 100);
    const medPct = Math.round((medium / sum) * 100);
    const easyEnd = easyPct;
    const medEnd = easyPct + medPct;
    donut.style.background = `conic-gradient(#60b987 0% ${easyEnd}%, #7cb9d1 ${easyEnd}% ${medEnd}%, #e0c85b ${medEnd}% 100%)`;
  }

  renderAdvancedStats(list, synced);

  const streak = calculateStreak();
  const solvedTargets = [["#dashboard-solved", total], ["#stats-streak", `${streak} days`], ["#dashboard-streak", `${streak} days`], ["#activity-session-count", sessionState.length], ["#activity-goal-completed", total], ["#activity-goal-percent", `${Math.min(100, Math.round((total / 500) * 100))}%`], ["#activity-goal-remaining", Math.max(0, 500 - total)], ["#activity-goal-progress", null]];
  solvedTargets.forEach(([selector, value]) => {
    const element = document.querySelector(selector);
    if (!element) return;
    if (selector === "#activity-goal-progress") element.style.width = `${Math.min(100, (total / 500) * 100)}%`;
    else element.textContent = value;
  });
  const goalPercent = Math.min(100, Math.round((total / 500) * 100));
  const goalRing = document.querySelector("#goal-progress-ring");
  const goalCopy = document.querySelector("#goal-progress-copy");
  const goalTrack = document.querySelector("#goal-progress-track");
  if (goalRing) goalRing.textContent = `${goalPercent}%`;
  if (goalCopy) goalCopy.textContent = `${total} of 500 problems`;
  if (goalTrack) goalTrack.style.width = `${goalPercent}%`;
  renderGoals(total);
  const focus = sessionState.reduce((minutes, session) => minutes + (Number.parseInt(session.time, 10) || 0), 0) / 60;
  const focusElement = document.querySelector("#dashboard-focus");
  if (focusElement) focusElement.innerHTML = `${focus.toFixed(1)} <small>hrs</small>`;
  const monthProgress = document.querySelector("#dashboard-month-progress");
  const bestStreak = document.querySelector("#dashboard-best-streak");
  const focusProgress = document.querySelector("#dashboard-focus-progress");
  if (monthProgress) monthProgress.innerHTML = `${countSubmissionsThisMonth()} submissions this month <span>↗</span>`;
  if (bestStreak) bestStreak.innerHTML = `Best streak is <strong>${calculateLongestStreak()} days</strong>`;
  if (focusProgress) focusProgress.innerHTML = `${loggedHoursThisWeek().toFixed(1)} hrs logged this week <span>↗</span>`;
  const streakBadge = document.querySelector("#activity-streak-badge") || document.querySelector('[data-view="activity"] .panel-badge');
  if (streakBadge) streakBadge.textContent = `${streak} day${streak === 1 ? "" : "s"} streak`;
  renderSubmissionChart();
  renderMonthCalendar();
  renderStreakDots();
  updateSidebarMiniProgress();
}

function renderAdvancedStats(list, stats) {
  const calendar = calendarObject(stats?.submissionCalendar);
  const now = new Date();
  const start = new Date(now);
  if (statsRange === "week") start.setDate(now.getDate() - 6);
  if (statsRange === "month") start.setDate(now.getDate() - 29);
  const rangeSubmissions = Object.entries(calendar).reduce((sum, [timestamp, count]) => new Date(Number(timestamp) * 1000) >= start ? sum + Number(count) : sum, 0);
  const acceptance = Number(stats.totalSubmissions) ? Math.round(((Number(stats.acceptedSubmissions) || 0) / Number(stats.totalSubmissions)) * 100) : 0;
  const minutes = list.reduce((sum, item) => sum + (Number.parseInt(item.time, 10) || 0), 0);
  const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  setText("#stats-acceptance", `${Math.min(100, acceptance)}%`);
  setText("#stats-average-time", `${list.length ? Math.round(minutes / list.length) : 0} min`);
  setText("#stats-tracked", statsRange === "all" ? list.length : rangeSubmissions);
  const label = document.querySelector("#stats-range-label");
  if (label) label.textContent = statsRange === "week" ? "This week" : statsRange === "month" ? "This month" : "All time";
  const languageCounts = stats.languageProblemCount?.length ? Object.fromEntries(stats.languageProblemCount.map((item) => [item.languageName, Number(item.problemsSolved) || 0])) : list.reduce((counts, item) => { const language = item.language || "Unknown"; counts[language] = (counts[language] || 0) + 1; return counts; }, {});
  const usage = document.querySelector("#language-usage");
  if (usage) {
    const languageTotal = Math.max(1, Object.values(languageCounts).reduce((sum, count) => sum + count, 0));
    usage.innerHTML = Object.entries(languageCounts).sort(([, first], [, second]) => second - first).map(([language, count]) => `<div class="usage-row"><span>${language}</span><strong>${Math.round(count / languageTotal * 100)}%</strong><i><em style="width:${count / languageTotal * 100}%"></em></i></div>`).join("") || "<p class=\"empty-state\">Sync or log problems to see language usage.</p>";
  }
}

function renderGoals(leetcodeTotal = leetcodeStats?.total || 0) {
  const goalList = document.querySelector(".goal-list");
  if (!goalList) return;
  goalList.innerHTML = "";
  if (!goalState.length) {
    goalList.innerHTML = `<p class="empty-state">No goals created yet. Click "+ Add a new goal" below.</p>`;
    return;
  }
  goalState.forEach((goal) => {
    const completed = goal.id === "leetcode" ? leetcodeTotal : Number(goal.completed) || 0;
    const target = Math.max(1, Number(goal.target) || 1);
    const percent = Math.min(100, Math.round((completed / target) * 100));
    const row = document.createElement("div");
    row.className = "goal-row";
    const dueLabel = goal.dueDate ? ` · Due ${goal.dueDate}` : "";
    const toneClass = goal.tone || (goal.id === "leetcode" ? "ring-green" : "ring-blue");
    row.innerHTML = `<div class="goal-ring ${toneClass}">${percent}%</div><div class="goal-copy"><strong>${goal.title}</strong><span>${goal.category || "General"} · ${goal.id === "leetcode" ? `${completed} of ${goal.target} problems` : `${completed} of ${goal.target} complete`}${dueLabel}</span><div class="tiny-track ${goal.tone === "ring-blue" ? "blue-track" : goal.tone === "ring-yellow" ? "yellow-track" : ""}"><i style="width:${percent}%"></i></div></div><button class="goal-edit" type="button" data-goal-id="${goal.id}" aria-label="Edit ${goal.title}">✎</button><button class="goal-delete" type="button" data-goal-id="${goal.id}" aria-label="Delete ${goal.title}">×</button>`;
    goalList.appendChild(row);
  });
}

function getAllActiveDays() {
  const counts = calendarObject(leetcodeStats?.submissionCalendar);
  const activeDays = new Set(
    Object.entries(counts)
      .filter(([, count]) => Number(count) > 0)
      .map(([timestamp]) => dateKeyFromTimestamp(timestamp))
  );
  sessionState.forEach((session) => {
    if (session.timestamp) {
      activeDays.add(dateKeyFromTimestamp(session.timestamp));
    }
  });
  return activeDays;
}

function calculateStreak() {
  const activeDays = getAllActiveDays();
  if (!activeDays.size) return 0;
  const today = new Date();
  const todayKey = dateKeyFromTimestamp(Math.floor(today.getTime() / 1000));
  if (!activeDays.has(todayKey)) today.setUTCDate(today.getUTCDate() - 1);
  let streak = 0;
  for (let offset = 0; offset < 3650; offset += 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - offset);
    const key = day.toISOString().slice(0, 10);
    if (!activeDays.has(key)) break;
    streak += 1;
  }
  return streak;
}

function dateKeyFromTimestamp(timestamp) {
  const numericTimestamp = Number(timestamp);
  const milliseconds = numericTimestamp < 100000000000 ? numericTimestamp * 1000 : numericTimestamp;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function calculateLongestStreak() {
  const activeDays = getAllActiveDays();
  let longest = 0;
  let current = 0;
  let previous = "";
  [...activeDays].sort().forEach((dayKey) => {
    const day = new Date(`${dayKey}T00:00:00Z`);
    const previousDay = previous ? new Date(`${previous}T00:00:00Z`) : null;
    current = previousDay && day - previousDay === 86400000 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = dayKey;
  });
  return longest;
}

function countSubmissionsThisMonth() {
  const now = new Date();
  let count = Object.entries(calendarObject(leetcodeStats?.submissionCalendar)).reduce((total, [timestamp, cnt]) => {
    const date = new Date(Number(timestamp) * 1000);
    return date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth() ? total + (Number(cnt) || 0) : total;
  }, 0);
  sessionState.forEach((session) => {
    if (session.timestamp) {
      const d = new Date(session.timestamp);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) count += 1;
    }
  });
  return count;
}

function loggedHoursThisWeek() {
  const now = new Date();
  const oneWeekAgo = now.getTime() - 7 * 86400000;
  return sessionState
    .filter((s) => !s.timestamp || s.timestamp >= oneWeekAgo)
    .reduce((total, session) => total + (Number.parseInt(session.time, 10) || 0), 0) / 60;
}

function updateSidebarMiniProgress() {
  const weeklyHours = loggedHoursThisWeek();
  const targetHours = 5.0;
  const percent = Math.min(100, Math.round((weeklyHours / targetHours) * 100));
  const percentElem = document.querySelector("#sidebar-weekly-percent");
  const barElem = document.querySelector("#sidebar-progress-bar");
  const labelElem = document.querySelector("#sidebar-progress-label");
  if (percentElem) percentElem.textContent = `${percent}%`;
  if (barElem) barElem.style.width = `${percent}%`;
  if (labelElem) {
    const wholeHours = Math.floor(weeklyHours);
    const minutes = Math.round((weeklyHours - wholeHours) * 60);
    labelElem.textContent = `${wholeHours}h ${minutes}m of 5h complete`;
  }
}

function calendarObject(calendar) {
  if (typeof calendar === "string") {
    try { return JSON.parse(calendar); } catch { return {}; }
  }
  return calendar || {};
}

function renderSubmissionChart() {
  const entries = Object.entries(calendarObject(leetcodeStats?.submissionCalendar)).sort(([first], [second]) => Number(first) - Number(second)).slice(-84);
  const values = entries.map(([, count]) => Number(count) || 0);
  if (!values.length) return;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${(values.length === 1 ? 0 : (index / (values.length - 1)) * 520).toFixed(1)} ${(190 - (value / max) * 170).toFixed(1)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L520 190 L0 190 Z`;
  const linePath = document.querySelector("#submission-line") || document.querySelector(".stats-grid-layout .chart-line");
  const areaPath = document.querySelector("#submission-area") || document.querySelector(".stats-grid-layout .chart-area-fill");
  const dot = document.querySelector("#submission-dot") || document.querySelector(".stats-grid-layout .chart-area circle");
  const chartTitle = [...document.querySelectorAll(".stats-grid-layout h2")].find((heading) => heading.textContent.includes("Problems over time"));
  if (chartTitle) chartTitle.textContent = "Submissions over time";
  if (linePath) linePath.setAttribute("d", line);
  if (areaPath) areaPath.setAttribute("d", area);
  if (dot) { const last = points[points.length - 1].split(" "); dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); }
}

async function syncLeetCodeProfile(force = false) {
  if (leetcodeSyncRequest) return leetcodeSyncRequest;
  if (!force && Date.now() - lastLeetCodeSync < 60000) {
    const cachedStatus = document.querySelector("#sync-status");
    if (cachedStatus) cachedStatus.textContent = "Using the latest saved LeetCode sync.";
    return;
  }
  lastLeetCodeSync = Date.now();
  const status = document.querySelector("#sync-status");
  const username = getLeetCodeUsername(profileState.leetcode);
  if (!username || username === "leetcode.com") {
    if (status) status.textContent = "Add your LeetCode profile link first.";
    return;
  }
  if (!navigator.onLine && leetcodeStats) {
    renderLeetCodeStats(leetcodeStats);
    if (status) status.textContent = "Offline mode: showing cached LeetCode data.";
    return;
  }
  if (status) status.textContent = `Syncing @${username}...`;
  document.querySelector(".profile-hero")?.classList.add("syncing");
  document.querySelector("#retry-sync")?.classList.add("hidden");
  leetcodeSyncRequest = (async () => {
    try {
      const response = await fetch(`${LEETCODE_API}/sync?username=${encodeURIComponent(username)}`, { credentials: "include" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Sync request returned ${response.status}`);
      const profile = result.profile;
      if (!profile || typeof profile.totalSolved === "undefined") throw new Error("Profile response was incomplete");
      renderLeetCodeStats(profile);
      renderLeetCodeSubmissions(result.submissions);
      updateDashboardStats();
      leetcodeStats.lastSynced = result.lastSynced;
      localStorage.setItem(userStorageKey("stats"), JSON.stringify(leetcodeStats));
      const syncedAt = result.lastSynced ? new Date(result.lastSynced * 1000).toLocaleString() : "unknown time";
      const lastSynced = document.querySelector("#last-synced");
      if (lastSynced) lastSynced.textContent = `Last synced: ${syncedAt}${result.cached ? " (cached)" : ""}`;
      if (status) status.textContent = result.stale ? "Showing the last saved sync." : result.submissionsUnavailable ? `Synced @${username}; recent submissions temporarily unavailable.` : `Synced @${username}`;
      showToast(result.stale ? "Showing cached LeetCode data." : "LeetCode profile synced.");
    } catch (error) {
      const message = error.name === "TimeoutError" ? "LeetCode took too long to respond." : error.message.includes("Failed to fetch") ? "Could not reach backend server (CORS or network)." : error.message;
      if (status) status.textContent = `Sync failed: ${message}`;
      document.querySelector("#retry-sync")?.classList.remove("hidden");
      showToast(`LeetCode sync failed: ${message}`);
    } finally {
      document.querySelector(".profile-hero")?.classList.remove("syncing");
      leetcodeSyncRequest = null;
    }
  })();
  return leetcodeSyncRequest;
}

function renderSessions() {
  const table = document.querySelector(".session-table");
  if (!table) return;
  table.querySelectorAll(".session-row:not(.table-header)").forEach((row) => row.remove());
  if (!sessionState.length) {
    const emptyRow = document.createElement("div");
    emptyRow.className = "session-row";
    emptyRow.innerHTML = `<span style="grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 12px 0;">No sessions logged yet. Click "+ Log a session" to add your first.</span>`;
    table.appendChild(emptyRow);
    return;
  }
  sessionState.slice(0, 5).forEach((session) => {
    const row = document.createElement("div");
    row.className = "session-row";
    const badgeChar = session.difficulty ? session.difficulty[0].toUpperCase() : "E";
    const diffClass = (session.difficulty || "Easy").toLowerCase();
    const dateStr = session.timestamp ? formatSessionDate(session.timestamp) : (session.date || "Recent");
    row.innerHTML = `<div class="problem-name"><span class="problem-badge ${diffClass}">${badgeChar}</span><strong>${session.name}</strong></div><span>${session.topic || "General"}</span><span class="difficulty ${diffClass}-text">${session.difficulty || "Easy"}</span><span>${session.time || "--"}</span><span>${dateStr}</span>`;
    table.appendChild(row);
  });
}

function updateDashboardStats() {
  updateStatsPage();
}

function openSessionModal() {
  createModal("Log a coding session", `<form class="modal-form"><label>Problem name<input name="name" required maxlength="80" placeholder="e.g. Merge Intervals"></label><div class="form-row"><label>Topic<input name="topic" required maxlength="40" placeholder="Arrays"></label><label>Time<input name="time" required maxlength="20" placeholder="32 min"></label></div><div class="form-row"><label>Difficulty<select name="difficulty"><option>Easy</option><option>Medium</option><option>Hard</option></select></label><label>Language<select name="language"><option>Python</option><option>C++</option><option>C</option><option>JavaScript</option><option>Java</option></select></label></div><button class="primary-button modal-submit" type="submit">Save session</button></form>`, (formData) => {
    const now = Date.now();
    sessionState.unshift({
      name: formData.get("name").trim(),
      topic: formData.get("topic").trim(),
      difficulty: formData.get("difficulty"),
      language: formData.get("language"),
      time: formData.get("time").trim(),
      timestamp: now,
      date: formatSessionDate(now)
    });
    localStorage.setItem(userStorageKey("sessions"), JSON.stringify(sessionState));
    renderSessions();
    updateDashboardStats();
    renderProblems();
    renderActivity();
    renderActivityTimeline();
    renderMonthCalendar();
    updateSidebarMiniProgress();
    showToast("Session saved. Nice work showing up.");
  });
}

function openGoalModal() {
  createGoalEditor();
}

function createGoalEditor(goal = null) {
  const isEdit = Boolean(goal);
  createModal(`${isEdit ? "Edit" : "Create"} a goal`, `<form class="modal-form"><label>Goal name<input name="goal" required maxlength="70" value="${goal?.title || ""}" placeholder="e.g. Solve 20 hard problems"></label><div class="form-row"><label>Category<select name="category"><option ${goal?.category === "Algorithms" ? "selected" : ""}>Algorithms</option><option ${goal?.category === "Projects" ? "selected" : ""}>Projects</option><option ${goal?.category === "Learning" ? "selected" : ""}>Learning</option><option ${goal?.category === "General" ? "selected" : ""}>General</option></select></label><label>Due date<input name="dueDate" type="date" value="${goal?.dueDate || ""}"></label></div><div class="form-row"><label>Target<input name="target" type="number" min="1" required value="${goal?.target || ""}"></label><label>Completed<input name="completed" type="number" min="0" required value="${goal?.completed || 0}"></label></div><label class="checkbox-setting"><input name="notify" type="checkbox" ${goal?.notify !== false ? "checked" : ""}><span>Notify me when completed or due soon</span></label><button class="primary-button modal-submit" type="submit">${isEdit ? "Save goal" : "Create goal"}</button></form>`, (formData) => {
    const nextGoal = {
      id: goal?.id || `goal-${Date.now()}`,
      title: formData.get("goal").trim(),
      category: formData.get("category"),
      dueDate: formData.get("dueDate"),
      target: Number(formData.get("target")),
      completed: Number(formData.get("completed")),
      notify: formData.get("notify") === "on",
      tone: goal?.tone || "ring-green"
    };
    if (isEdit) goalState = goalState.map((item) => item.id === goal.id ? nextGoal : item);
    else goalState.unshift(nextGoal);
    localStorage.setItem(userStorageKey("goals"), JSON.stringify(goalState));
    renderGoals(leetcodeStats?.total || 0);
    showGoalNotification(nextGoal);
    showToast(isEdit ? "Goal updated." : "Goal added to your dashboard.");
  });
}

function showGoalNotification(goal) {
  if (!goal.notify) return;
  if (goal.completed >= goal.target) {
    showToast(`Goal complete: ${goal.title}`);
  } else if (goal.dueDate) {
    const diffDays = Math.ceil((new Date(`${goal.dueDate}T00:00:00`) - new Date()) / 86400000);
    if (diffDays >= 0 && diffDays <= 3) {
      showToast(`Goal due soon (${diffDays === 0 ? "today" : `in ${diffDays} day${diffDays === 1 ? "" : "s"}`}): ${goal.title}`);
    } else if (diffDays < 0) {
      showToast(`Goal overdue: ${goal.title}`);
    }
  }
}

function openNotifications() {
  const notices = [];
  const streak = calculateStreak();
  const todayKey = dateKeyFromTimestamp(Math.floor(Date.now() / 1000));
  const activeDays = getAllActiveDays();
  const hasToday = activeDays.has(todayKey);
  if (streak > 0 && !hasToday) notices.push("Your streak is at risk. Solve one problem today to keep it alive.");
  else if (streak > 0) notices.push(`Great job! You have an active ${streak} day streak.`);
  goalState.filter((goal) => goal.notify && goal.completed >= goal.target).forEach((goal) => notices.push(`Goal complete: ${goal.title}`));
  goalState.filter((goal) => goal.notify && goal.dueDate && (new Date(`${goal.dueDate}T00:00:00`) - new Date()) / 86400000 <= 3 && goal.completed < goal.target).forEach((goal) => notices.push(`Goal due soon: ${goal.title}`));
  const weekly = countSubmissionsThisMonth();
  notices.push(`Summary: ${weekly} coding submissions logged this month.`);
  createModal("Notifications", `<div class="notification-list">${notices.map((notice) => `<p>• ${notice}</p>`).join("")}</div>`);
}

function openSettingsModal() {
  createModal("Settings", `<form class="modal-form"><p class="settings-section-title">Appearance</p><label>Theme<select name="theme"><option value="light">Light theme</option><option value="dark">Dark theme</option></select></label><p class="settings-section-title">Account</p><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" placeholder="Required for account changes"></label><label>New email address<input name="newEmail" type="email" autocomplete="email" placeholder="Leave blank to keep current email"></label><label>New password<input name="newPassword" type="password" minlength="6" autocomplete="new-password" placeholder="Leave blank to keep current password"></label><p class="settings-section-title">Data</p><label class="checkbox-setting"><input name="clearData" type="checkbox"><span>Clear locally saved sessions</span></label><button class="primary-button modal-submit" type="submit">Save settings</button></form>`, (formData) => {
    applyTheme(formData.get("theme"));
    localStorage.setItem(userStorageKey("theme"), formData.get("theme"));
    const currentPassword = formData.get("currentPassword");
    const newEmail = formData.get("newEmail").trim().toLowerCase();
    const newPassword = formData.get("newPassword");
    if (newEmail || newPassword) {
      accountRequest({ currentPassword, email: newEmail || activeUserId, newPassword })
        .then((result) => {
          if (newEmail && newEmail !== activeUserId) {
            ["sessions", "profile", "remote-problems", "stats", "goals", "theme"].forEach((key) => {
              const oldKey = `codetrack:${activeUserId}:${key}`;
              const newKey = `codetrack:${newEmail}:${key}`;
              const value = localStorage.getItem(oldKey);
              if (value !== null) localStorage.setItem(newKey, value);
              localStorage.removeItem(oldKey);
            });
            localStorage.setItem("codetrack-active-user", result.user.email);
            activeUserId = result.user.email;
          }
          showToast("Account settings saved.");
        })
        .catch((error) => showToast(error.message));
    }
    if (formData.get("clearData")) {
      sessionState.splice(0, sessionState.length);
      localStorage.removeItem(userStorageKey("sessions"));
      renderSessions();
      updateDashboardStats();
      renderProblems();
      renderActivity();
      renderActivityTimeline();
      renderMonthCalendar();
      updateSidebarMiniProgress();
    }
    showToast("Settings saved.");
  });

  const themeSelect = document.querySelector(".modal select[name='theme']");
  const settingsForm = document.querySelector(".modal .modal-form");
  if (settingsForm) {
    const backupTools = document.createElement("div");
    backupTools.className = "backup-tools";
    backupTools.innerHTML = `<p class="settings-section-title">Backup & export</p><div class="form-row"><button class="text-button" id="export-json" type="button">Download JSON</button><button class="text-button" id="export-csv" type="button">Download CSV</button></div><label class="text-button restore-label">Restore JSON<input id="restore-json" type="file" accept="application/json" hidden></label>`;
    settingsForm.insertBefore(backupTools, settingsForm.querySelector(".modal-submit"));
    backupTools.querySelector("#export-json").addEventListener("click", () => exportBackup("json"));
    backupTools.querySelector("#export-csv").addEventListener("click", () => exportBackup("csv"));
    backupTools.querySelector("#restore-json").addEventListener("change", (event) => event.target.files[0] && restoreBackup(event.target.files[0]));
  }
  if (themeSelect) themeSelect.value = document.documentElement.dataset.theme || "light";
}

function renderActivity() {
  const heatmap = document.querySelector("#heatmap");
  if (!heatmap) return;
  heatmap.innerHTML = "";
  const counts = calendarObject(leetcodeStats?.submissionCalendar);
  const dayCounts = {};
  Object.entries(counts).forEach(([timestamp, count]) => {
    const key = dateKeyFromTimestamp(timestamp);
    dayCounts[key] = (dayCounts[key] || 0) + Number(count);
  });
  sessionState.forEach((session) => {
    if (session.timestamp) {
      const key = dateKeyFromTimestamp(session.timestamp);
      dayCounts[key] = (dayCounts[key] || 0) + 1;
    }
  });

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const totalCells = 84;
  let totalPeriodSessions = 0;

  for (let i = totalCells - 1; i >= 0; i -= 1) {
    const cellDate = new Date(todayUtc);
    cellDate.setUTCDate(todayUtc.getUTCDate() - i);
    const key = cellDate.toISOString().slice(0, 10);
    const count = dayCounts[key] || 0;
    totalPeriodSessions += count;
    const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
    const cell = document.createElement("span");
    cell.className = `heat-cell level-${level}`;
    const dateFormatted = cellDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    cell.title = `${dateFormatted}: ${count} activity session${count === 1 ? "" : "s"}`;
    heatmap.appendChild(cell);
  }

  const sessionCountElem = document.querySelector("#activity-session-count");
  if (sessionCountElem) sessionCountElem.textContent = totalPeriodSessions;

  const monthLabelsElem = document.querySelector("#overview-month-labels");
  if (monthLabelsElem) {
    const m3 = new Date(todayUtc);
    const m2 = new Date(todayUtc); m2.setUTCMonth(m2.getUTCMonth() - 1);
    const m1 = new Date(todayUtc); m1.setUTCMonth(m1.getUTCMonth() - 2);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: "short" });
    monthLabelsElem.innerHTML = `<span>${fmt(m1)}</span><span>${fmt(m2)}</span><span>${fmt(m3)}</span>`;
  }
}

function renderMonthCalendar() {
  const calendar = document.querySelector("#calendar-grid");
  if (!calendar) return;
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const monthStart = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDay = (monthStart.getUTCDay() + 6) % 7;
  const counts = calendarObject(leetcodeStats?.submissionCalendar);
  const dayCounts = {};
  Object.entries(counts).forEach(([timestamp, count]) => {
    const key = dateKeyFromTimestamp(timestamp);
    dayCounts[key] = (dayCounts[key] || 0) + Number(count);
  });
  sessionState.forEach((session) => {
    if (session.timestamp) {
      const key = dateKeyFromTimestamp(session.timestamp);
      dayCounts[key] = (dayCounts[key] || 0) + 1;
    }
  });

  calendar.innerHTML = "";
  for (let blank = 0; blank < firstDay; blank += 1) {
    const emptyCell = document.createElement("i");
    emptyCell.className = "calendar-empty";
    emptyCell.setAttribute("aria-hidden", "true");
    calendar.appendChild(emptyCell);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(Date.UTC(year, month, day));
    const dayKey = date.toISOString().slice(0, 10);
    const count = Number(dayCounts[dayKey]) || 0;
    const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 7 ? 3 : 4;
    const cell = document.createElement("i");
    cell.textContent = day;
    cell.className = `level-${level}`;
    if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
      cell.classList.add("today");
    }
    const readableDate = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    cell.dataset.tooltip = `${readableDate}: ${count} submission${count === 1 ? "" : "s"}`;
    cell.setAttribute("aria-label", cell.dataset.tooltip);
    calendar.appendChild(cell);
  }
  const monthLabel = document.querySelector("[data-view=activity] .streak-calendar")?.closest(".panel")?.querySelector(".kicker");
  if (monthLabel) monthLabel.textContent = today.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function renderStreakDots() {
  const dots = document.querySelector(".streak-dots");
  if (!dots) return;
  const streak = calculateStreak();
  dots.setAttribute("aria-label", `${streak} day streak`);
  dots.innerHTML = Array.from({ length: Math.max(7, Math.min(streak, 21)) }, (_, index) => `<i class="${index < streak ? "streak-active" : ""}"></i>`).join("");
}

function renderActivityTimeline() {
  const timeline = document.querySelector("#activity-timeline");
  if (!timeline) return;
  timeline.innerHTML = "";
  if (!sessionState.length) {
    timeline.innerHTML = `<p class="empty-state">No recent activity yet.</p>`;
    return;
  }
  sessionState.slice(0, 5).forEach((session) => {
    const entry = document.createElement("div");
    const dateStr = session.timestamp ? formatSessionDate(session.timestamp) : (session.date || "Recent");
    entry.innerHTML = `<span>✓</span><p><strong>Solved ${session.name}</strong><small>${session.topic || "Practice"} · ${session.difficulty || "Easy"} · ${dateStr}</small></p>`;
    timeline.appendChild(entry);
  });
}

function renderActivitySummary() {
  const now = new Date();
  const start = new Date(now);
  if (activityRange === "week") start.setDate(now.getDate() - 6);
  if (activityRange === "month") start.setDate(now.getDate() - 29);
  const calendar = calendarObject(leetcodeStats?.submissionCalendar);
  const entries = Object.entries(calendar).filter(([timestamp]) => new Date(Number(timestamp) * 1000) >= start);
  const submissions = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  const activeDays = entries.filter(([, count]) => Number(count) > 0).length;
  const label = document.querySelector("#activity-range-label");
  if (label) label.textContent = activityRange === "week" ? "Last 7 days" : activityRange === "month" ? "This month" : "All time";
  const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  setText("#activity-submissions", submissions);
  setText("#activity-solved", activityRange === "all" ? (leetcodeStats?.total || trackedProblems().length) : activeDays);
  setText("#activity-active-days", activeDays);
  const summaryTitle = document.querySelector("#monthly-summary-title");
  const summaryCopy = document.querySelector("#monthly-summary-copy");
  if (summaryTitle) summaryTitle.textContent = `${now.toLocaleDateString(undefined, { month: "long", year: "numeric" })} summary`;
  if (summaryCopy) summaryCopy.textContent = `${submissions} submissions across ${activeDays} active days. ${activityRange === "month" ? "This is your current month." : "Change the range to compare your activity."}`;
}

async function loadGithubStats() {
  const match = String(profileState.github || "").match(/github\.com\/([^/]+)/i);
  const count = document.querySelector("#github-repo-count");
  const stats = document.querySelector("#github-stats");
  if (!match || !stats) return;
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(match[1])}`);
    if (!response.ok) throw new Error("GitHub profile not found");
    const data = await response.json();
    if (count) count.textContent = `${data.public_repos} repos`;
    stats.innerHTML = `<div><strong>${data.public_repos}</strong><span>Public repositories</span></div><div><strong>${data.followers}</strong><span>Followers</span></div><div><strong>${data.following}</strong><span>Following</span></div>`;
  } catch {
    if (count) count.textContent = "Unavailable";
    stats.textContent = "GitHub stats could not be loaded right now.";
  }
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  if (themeToggle) {
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    themeToggle.querySelector(".theme-icon").textContent = isDark ? "☀" : "☾";
    themeToggle.querySelector(".theme-label").textContent = isDark ? "Light" : "Dark";
  }
}

themeToggle?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(userStorageKey("theme"), nextTheme);
  applyTheme(nextTheme);
});

function showPage(pageName) {
  const validPage = pages.some((page) => page.dataset.view === pageName) ? pageName : "dashboard";
  pages.forEach((page) => page.classList.toggle("hidden", page.dataset.view !== validPage));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === validPage));
  if (pageLabel) {
    pageLabel.textContent = validPage[0].toUpperCase() + validPage.slice(1);
  }
  sidebar.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleNavigation(event) {
  const pageName = event.currentTarget.dataset.page;
  if (!pageName) return;
  event.preventDefault();
  window.location.hash = pageName;
  showPage(pageName);
}

navItems.forEach((item) => item.addEventListener("click", handleNavigation));
window.addEventListener("hashchange", () => showPage(window.location.hash.slice(1)));

document.querySelector(".menu-button")?.addEventListener("click", () => sidebar.classList.toggle("open"));
document.querySelector("#log-session")?.addEventListener("click", openSessionModal);
document.querySelector("#new-goal")?.addEventListener("click", openGoalModal);
document.querySelector("#view-all-sessions")?.addEventListener("click", () => {
  window.location.hash = "problems";
  showPage("problems");
});

document.querySelector(".goal-list")?.addEventListener("click", (event) => {
  const editButton = event.target.closest(".goal-edit");
  if (editButton) {
    const goal = goalState.find((item) => item.id === editButton.dataset.goalId);
    if (goal) createGoalEditor(goal);
    return;
  }
  const deleteButton = event.target.closest(".goal-delete");
  if (!deleteButton) return;
  const goal = goalState.find((item) => item.id === deleteButton.dataset.goalId);
  if (!goal || !window.confirm(`Delete "${goal.title}"?`)) return;
  goalState = goalState.filter((item) => item.id !== goal.id);
  localStorage.setItem(userStorageKey("goals"), JSON.stringify(goalState));
  renderGoals(leetcodeStats?.total || 0);
  showToast("Goal deleted.");
});

document.querySelector("#add-problem")?.addEventListener("click", openSessionModal);
document.querySelector("#settings-button")?.addEventListener("click", openSettingsModal);
document.querySelector("#profile-card")?.addEventListener("click", openProfileModal);
document.querySelector("#edit-profile")?.addEventListener("click", openProfileModal);
document.querySelector("#sync-leetcode")?.addEventListener("click", () => syncLeetCodeProfile(true));
document.querySelector("#sync-stats")?.addEventListener("click", () => syncLeetCodeProfile(true));
document.querySelector("#retry-sync")?.addEventListener("click", () => syncLeetCodeProfile(true));
document.querySelector(".notification-button")?.addEventListener("click", openNotifications);
document.querySelector("#upload-photo")?.addEventListener("click", () => document.querySelector("#photo-input")?.click());

document.querySelector("#photo-input")?.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    profileState.photo = reader.result;
    localStorage.setItem(userStorageKey("profile"), JSON.stringify(profileState));
    renderProfile();
    showToast("Profile photo updated.");
  };
  reader.readAsDataURL(file);
});

document.querySelector("#share-profile")?.addEventListener("click", async () => {
  const shareData = {
    name: profileState.name,
    role: profileState.role,
    description: profileState.description,
    github: profileState.github,
    linkedin: profileState.linkedin,
    leetcode: profileState.leetcode,
    skills: profileState.skills,
    total: leetcodeStats?.total || 0,
    streak: calculateStreak()
  };
  const shareUrl = `${window.location.origin}${window.location.pathname}#public=${encodeURIComponent(JSON.stringify(shareData))}`;
  try {
    await navigator.clipboard?.writeText(shareUrl);
    showToast("Profile link copied to clipboard.");
  } catch {
    showToast("Profile link created in URL.");
  }
});

document.querySelectorAll("[data-activity-range]").forEach((button) => {
  button.addEventListener("click", () => {
    activityRange = button.dataset.activityRange;
    document.querySelectorAll("[data-activity-range]").forEach((item) => item.classList.toggle("active", item === button));
    renderActivitySummary();
  });
});

document.querySelectorAll(".select-button").forEach((button) => {
  button.addEventListener("click", () => showToast("Showing the last 12 weeks of activity."));
});

document.querySelectorAll("[data-stats-range]").forEach((button) => {
  button.addEventListener("click", () => {
    statsRange = button.dataset.statsRange;
    document.querySelectorAll("[data-stats-range]").forEach((item) => item.classList.toggle("active", item === button));
    updateStatsPage();
  });
});

function difficultyClass(difficulty) {
  return (difficulty || "Easy").toLowerCase();
}

function renderProblems() {
  const table = document.querySelector("#problem-table");
  if (!table) return;
  const search = document.querySelector("#problem-search")?.value.trim().toLowerCase() || "";
  const filter = document.querySelector(".filter-button.active")?.dataset.filter || "all";
  const language = document.querySelector("#language-filter")?.value || "all";
  const sort = document.querySelector("#sort-problems")?.value || "recent";
  const visible = trackedProblems()
    .filter((problem) => !search || problem.name.toLowerCase().includes(search) || (problem.topic && problem.topic.toLowerCase().includes(search)))
    .filter((problem) => filter === "all" || problem.difficulty === filter)
    .filter((problem) => language === "all" || problem.language === language)
    .sort((a, b) => {
      if (sort === "name") return String(a.name).localeCompare(String(b.name));
      if (sort === "difficulty") return String(a.difficulty).localeCompare(String(b.difficulty));
      return (b.timestamp || 0) - (a.timestamp || 0) || String(b.date || "").localeCompare(String(a.date || ""));
    });

  table.querySelectorAll(".problem-table-row:not(.table-header)").forEach((row) => row.remove());
  visible.forEach((problem) => {
    const row = document.createElement("div");
    row.className = "problem-table-row";
    const badgeChar = problem.difficulty ? problem.difficulty[0].toUpperCase() : "E";
    const dateStr = problem.timestamp ? formatSessionDate(problem.timestamp) : (problem.date || "Recent");
    row.innerHTML = `<div class="problem-name"><span class="problem-badge ${difficultyClass(problem.difficulty)}">${badgeChar}</span><strong>${problem.name}</strong></div><span class="difficulty ${difficultyClass(problem.difficulty)}-text">${problem.difficulty}</span><span>${problem.language}</span><span class="status-solved">✓ Solved</span><span>${dateStr}</span>`;
    table.appendChild(row);
  });
  document.querySelector("#empty-state")?.classList.toggle("hidden", visible.length > 0);
}

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter-button").forEach((filterButton) => filterButton.classList.remove("active"));
    button.classList.add("active");
    renderProblems();
  });
});

document.querySelector("#problem-search")?.addEventListener("input", renderProblems);
document.querySelector("#language-filter")?.addEventListener("change", renderProblems);
document.querySelector("#sort-problems")?.addEventListener("change", renderProblems);

// Restore active session or show authentication
restoreSession();
showPage(window.location.hash.slice(1) || "dashboard");
const resetToken = new URLSearchParams(window.location.search).get("reset");
if (resetToken) openResetModal(resetToken);

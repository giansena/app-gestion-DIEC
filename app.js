const SESSION_KEY = "diec-gestion-user";
const USERS = new Set([
  "Pamela Pérez",
  "Nataniel Goyechea",
  "Alen García",
  "David Maglione",
  "Roberto Martin",
  "DIEC SAS",
]);

const loginScreen = document.querySelector("#login-screen");
const homeScreen = document.querySelector("#home-screen");
const loginError = document.querySelector("#login-error");
const homeError = document.querySelector("#home-error");
const userButtons = document.querySelectorAll("[data-user]");
const avatarClasses = [
  "avatar-blue",
  "avatar-teal",
  "avatar-lavender",
  "avatar-sky",
  "avatar-slate",
  "avatar-navy",
];

document.querySelector("#current-year").textContent = new Date().getFullYear();
document.querySelectorAll(".footer-year").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

function initialsFor(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toLocaleUpperCase("es");
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function setAvatar(element, name) {
  const index = [...USERS].indexOf(name);
  element.textContent = initialsFor(name);
  element.classList.remove(...avatarClasses);
  element.classList.add(avatarClasses[index] ?? avatarClasses[0]);
}

function showHome(name) {
  document.querySelector("#welcome-name").textContent = name.split(" ")[0];
  document.querySelector("#header-name").textContent = name;
  document.querySelector("#workspace-name").textContent = name;
  document.querySelector("#note-name").textContent = name;
  setAvatar(document.querySelector("#header-avatar"), name);
  setAvatar(document.querySelector("#workspace-avatar"), name);
  loginScreen.hidden = true;
  homeScreen.hidden = false;
}

function showLogin() {
  homeScreen.hidden = true;
  loginScreen.hidden = false;
  loginError.hidden = true;
  homeError.hidden = true;
}

function readSession() {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    showError(loginError, "No se pudo recuperar tu sesión guardada. Comprueba la configuración de almacenamiento de este navegador.");
    return null;
  }
}

function startSession(name) {
  loginError.hidden = true;
  try {
    window.localStorage.setItem(SESSION_KEY, name);
  } catch {
    showError(loginError, "No se pudo guardar tu sesión en este navegador. Revisa el almacenamiento disponible e inténtalo de nuevo.");
    return;
  }
  showHome(name);
}

function endSession() {
  homeError.hidden = true;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    showError(homeError, "No se pudo cerrar la sesión guardada. Comprueba la configuración de almacenamiento e inténtalo de nuevo.");
    return;
  }
  showLogin();
  document.querySelector(".user-option").focus();
}

userButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.dataset.user;
    if (USERS.has(name)) {
      startSession(name);
    }
  });
});

document.querySelector("#logout-button").addEventListener("click", endSession);
document.querySelector("#note-logout-button").addEventListener("click", endSession);

const savedUser = readSession();
if (savedUser && USERS.has(savedUser)) {
  showHome(savedUser);
} else if (savedUser) {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    showError(loginError, "No se pudo limpiar una sesión no válida. Comprueba la configuración de almacenamiento del navegador.");
  }
}

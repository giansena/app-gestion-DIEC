const SESSION_KEY = "diec-flow-user";
const FALLBACK_USERS = [
  "Pamela Pérez",
  "Nataniel Goyechea",
  "David Maglione",
  "Alen García",
  "Roberto Martin",
  "DIEC SAS",
];
const COLORS = ["#dff2fc", "#e7f5ef", "#f0eafa", "#e8f1fc", "#edf1f4", "#e6eef7"];
const $ = (selector) => document.querySelector(selector);

const state = { users: FALLBACK_USERS, user: null, tasks: [], view: "personal", status: "pending", busy: false };
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");
const dialog = $("#task-dialog");
const completionDialog = $("#completion-dialog");
let toastTimer;
let pendingCompletion = null;
let taskFetchVersion = 0;

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase("es");
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "No se pudo completar la solicitud.");
  return result;
}

function renderUsers() {
  $("#user-list").replaceChildren(...state.users.map((name, index) => {
    const button = document.createElement("button");
    button.className = "user-option";
    button.type = "button";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = COLORS[index % COLORS.length];
    avatar.textContent = initials(name);
    const label = document.createElement("span");
    label.className = "user-name";
    label.textContent = name;
    const arrow = document.createElement("span");
    arrow.className = "user-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    button.append(avatar, label, arrow);
    button.addEventListener("click", () => startSession(name));
    return button;
  }));
}

async function loadUsers() {
  try {
    const result = await api("/users");
    state.users = result.users;
    renderUsers();
  } catch {
    renderUsers();
    showError($("#login-error"), "No se pudo conectar con el servidor. Comprobá que DIEC flow esté en ejecución e intentá de nuevo.");
  }
}

function startSession(name) {
  try {
    localStorage.setItem(SESSION_KEY, name);
  } catch {
    showError($("#login-error"), "No se pudo guardar tu sesión en este dispositivo. Revisá el almacenamiento del navegador.");
    return;
  }
  state.user = name;
  state.view = "personal";
  state.status = "pending";
  updateStatusControls();
  $("#login-error").hidden = true;
  loginScreen.hidden = true;
  appScreen.hidden = false;
  $("#header-user").textContent = name;
  $("#header-avatar").textContent = initials(name);
  $("#welcome-title").textContent = `Hola, ${name.split(" ")[0]}`;
  setView("personal");
}

function endSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    showToast("No se pudo cerrar la sesión guardada en este navegador.", true);
    return;
  }
  taskFetchVersion += 1;
  state.user = null;
  state.tasks = [];
  state.busy = false;
  appScreen.hidden = true;
  loginScreen.hidden = false;
  $("#user-list button")?.focus();
}

function setView(view) {
  state.view = view;
  state.tasks = [];
  $("#personal-view").classList.toggle("is-active", view === "personal");
  $("#global-view").classList.toggle("is-active", view === "global");
  $("#personal-view").setAttribute("aria-pressed", String(view === "personal"));
  $("#global-view").setAttribute("aria-pressed", String(view === "global"));
  updateTasksTitle();
  renderTasks();
  if (state.user) void refreshTasks();
}

function updateTasksTitle() {
  const labels = {
    personal: { pending: "Mis pendientes", completed: "Mis tareas completadas" },
    global: { pending: "Todas las tareas pendientes", completed: "Todas las tareas completadas" },
  };
  $("#tasks-title").textContent = labels[state.view][state.status];
}

function updateStatusControls() {
  $("#pending-status").classList.toggle("is-active", state.status === "pending");
  $("#completed-status").classList.toggle("is-active", state.status === "completed");
  $("#pending-status").setAttribute("aria-pressed", String(state.status === "pending"));
  $("#completed-status").setAttribute("aria-pressed", String(state.status === "completed"));
}

function setStatus(status) {
  state.status = status;
  state.tasks = [];
  updateStatusControls();
  updateTasksTitle();
  renderTasks();
  if (state.user) void refreshTasks();
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderTasks() {
  const list = $("#task-list");
  list.replaceChildren();
  const tasks = state.tasks;
  const isCompletedView = state.status === "completed";
  const taskLabel = isCompletedView ? "completada" : "pendiente";
  $("#task-count").textContent = `${tasks.length} ${tasks.length === 1 ? `tarea ${taskLabel}` : `tareas ${isCompletedView ? "completadas" : "pendientes"}`}`;
  $("#empty-state").hidden = state.busy || tasks.length > 0 || !$("#board-error").hidden;
  $("#empty-title").textContent = isCompletedView ? "Aún no hay tareas completadas" : "Todo al día";
  $("#empty-description").textContent = isCompletedView
    ? "Las tareas terminadas aparecerán aquí."
    : "No hay tareas pendientes en esta vista. ¡Buen trabajo!";
  $("#loading").hidden = !state.busy;

  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = isCompletedView ? "task-card is-completed" : "task-card";
    if (isCompletedView) {
      const badge = document.createElement("span");
      badge.className = "completed-badge";
      badge.textContent = "✓ Completada";
      card.append(badge);
    } else {
      const complete = document.createElement("button");
      complete.type = "button";
      complete.className = "complete-button";
      const completeIcon = document.createElement("span");
      completeIcon.className = "complete-icon";
      completeIcon.setAttribute("aria-hidden", "true");
      completeIcon.textContent = "✓";
      const completeLabel = document.createElement("span");
      completeLabel.textContent = "Completar";
      complete.append(completeIcon, completeLabel);
      complete.setAttribute("aria-label", `Marcar como terminada: ${task.description}`);
      complete.addEventListener("click", () => requestCompletion(task, complete));
      card.append(complete);
    }

    const body = document.createElement("div");
    body.className = "task-body";
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const created = document.createElement("span");
    created.textContent = `Creada ${formatDate(task.createdAt)}`;
    meta.append(created);
    if (task.dueDate) {
      const due = document.createElement("span");
      due.textContent = `${isCompletedView ? "Vencía" : "Vence"} ${formatDate(task.dueDate)}`;
      if (!isCompletedView && new Date(`${task.dueDate}T23:59:59`) < new Date()) due.className = "overdue";
      meta.append(due);
    }
    if (isCompletedView) {
      const completedAt = document.createElement("span");
      completedAt.className = "completed-at";
      completedAt.textContent = `Completada ${formatDateTime(task.completedAt)}${task.completedBy ? ` por ${task.completedBy}` : ""}`;
      meta.append(completedAt);
    }
    const recipients = document.createElement("div");
    recipients.className = "assignee-list";
    for (const recipient of task.recipients) {
      const chip = document.createElement("span");
      chip.className = "assignee-chip";
      chip.textContent = recipient;
      recipients.append(chip);
    }
    body.append(description, meta, recipients);
    card.append(body);
    list.append(card);
  }
}

async function refreshTasks() {
  if (!state.user) return;
  const requestVersion = ++taskFetchVersion;
  state.busy = true;
  $("#board-error").hidden = true;
  renderTasks();
  try {
    const query = new URLSearchParams({ view: state.view, user: state.user, status: state.status });
    const result = await api(`/tasks?${query}`);
    if (requestVersion !== taskFetchVersion) return;
    state.tasks = result.tasks;
  } catch (error) {
    if (requestVersion === taskFetchVersion) showError($("#board-error"), error.message);
  } finally {
    if (requestVersion === taskFetchVersion) {
      state.busy = false;
      renderTasks();
    }
  }
}

async function completeTask(task, button) {
  taskFetchVersion += 1;
  state.busy = false;
  button.disabled = true;
  state.tasks = state.tasks.filter((item) => item.id !== task.id);
  renderTasks();
  try {
    const result = await api(`/tasks/${encodeURIComponent(task.id)}/complete`, {
      method: "PATCH",
      body: JSON.stringify({ completedBy: state.user }),
    });
    if (result.azureSync?.status !== "synced") {
      showToast("Tarea completada. Sincronización con Azure SQL pendiente; el servidor volverá a intentarlo.", true);
    } else {
      showToast("¡Tarea completada!");
    }
    if (state.status === "completed") await refreshTasks();
  } catch (error) {
    showToast(error.message, true);
    await refreshTasks();
  }
}

function requestCompletion(task, button) {
  pendingCompletion = { task, button };
  $("#completion-description").textContent = task.description;
  $("#confirm-completion").disabled = false;
  completionDialog.showModal();
}

async function confirmCompletion() {
  if (!pendingCompletion) return;
  const { task, button } = pendingCompletion;
  $("#confirm-completion").disabled = true;
  completionDialog.close();
  await completeTask(task, button);
  $("#confirm-completion").disabled = false;
}

function showToast(message, warning = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-warning", warning);
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

function openDialog() {
  $("#form-error").hidden = true;
  $("#task-form").reset();
  $("#save-task").disabled = false;
  $("#recipient-list").replaceChildren(...state.users.map((name) => {
    const label = document.createElement("label");
    label.className = "recipient-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "recipients";
    checkbox.value = name;
    checkbox.checked = name === state.user;
    const text = document.createElement("span");
    text.textContent = name;
    label.append(checkbox, text);
    return label;
  }));
  dialog.showModal();
  $("#description").focus();
}

async function createTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const description = $("#description").value.trim();
  const recipients = [...form.querySelectorAll('input[name="recipients"]:checked')].map((checkbox) => checkbox.value);
  if (!description || recipients.length === 0) {
    showError($("#form-error"), "Escribí una descripción y elegí al menos una persona.");
    return;
  }
  const button = $("#save-task");
  button.disabled = true;
  $("#form-error").hidden = true;
  try {
    await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ description, recipients, dueDate: $("#due-date").value || null, createdBy: state.user }),
    });
    state.status = "pending";
    updateStatusControls();
    updateTasksTitle();
    dialog.close();
    showToast("Tarea creada.");
    await refreshTasks();
  } catch (error) {
    showError($("#form-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

$("#logout-button").addEventListener("click", endSession);
$("#personal-view").addEventListener("click", () => setView("personal"));
$("#global-view").addEventListener("click", () => setView("global"));
$("#pending-status").addEventListener("click", () => setStatus("pending"));
$("#completed-status").addEventListener("click", () => setStatus("completed"));
$("#add-task-button").addEventListener("click", openDialog);
$("#close-dialog").addEventListener("click", () => dialog.close());
$("#cancel-dialog").addEventListener("click", () => dialog.close());
$("#task-form").addEventListener("submit", (event) => void createTask(event));
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
$("#cancel-completion").addEventListener("click", () => completionDialog.close());
$("#close-completion").addEventListener("click", () => completionDialog.close());
$("#confirm-completion").addEventListener("click", () => void confirmCompletion());
completionDialog.addEventListener("click", (event) => {
  if (event.target === completionDialog) completionDialog.close();
});
completionDialog.addEventListener("close", () => {
  pendingCompletion = null;
});

renderUsers();
void loadUsers();
try {
  const savedUser = localStorage.getItem(SESSION_KEY);
  if (savedUser && FALLBACK_USERS.includes(savedUser)) startSession(savedUser);
  else if (savedUser) localStorage.removeItem(SESSION_KEY);
} catch {
  showError($("#login-error"), "No se pudo recuperar la sesión guardada. Revisá el almacenamiento del navegador.");
}

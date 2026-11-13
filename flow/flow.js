const COLORS = ["#dff2fc", "#e7f5ef", "#f0eafa", "#e8f1fc", "#edf1f4", "#e6eef7"];
const $ = (selector) => document.querySelector(selector);

const state = {
  users: [],
  user: null,
  pendingLoginName: null,
  tasks: [],
  clientWorks: [],
  notifications: [],
  view: "personal",
  status: "active",
  busy: false,
};
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");
const dialog = $("#task-dialog");
const completionDialog = $("#completion-dialog");
const clientWorksDialog = $("#client-works-dialog");
const notificationsDialog = $("#notifications-dialog");
let toastTimer;
let pendingTaskAction = null;
let editingTaskId = null;
let taskFetchVersion = 0;
let notificationTimer;
let notificationsInitialized = false;

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
  if (response.status === 401 && state.user) clearSessionState();
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
    button.addEventListener("click", () => selectUser(name));
    return button;
  }));
}

async function loadUsers() {
  try {
    const result = await api("/users");
    state.users = result.users;
    renderUsers();
  } catch (error) {
    console.error("No se pudo cargar la lista de usuarios:", error);
    showError($("#login-error"), "No se pudo cargar la lista de usuarios. Comprobá la conexión e intentá de nuevo.");
  }
}

function selectUser(name) {
  state.pendingLoginName = name;
  $("#login-selected-user").textContent = `Ingresar como ${name}`;
  $("#login-form").hidden = false;
  $("#user-list").hidden = true;
  $("#login-error").hidden = true;
  $("#login-pin").value = "";
  $("#login-pin").focus();
}

async function startSession(event) {
  event.preventDefault();
  const name = state.pendingLoginName;
  const pin = $("#login-pin").value;
  if (!name || !/^\d{4}$/.test(pin)) {
    showError($("#login-error"), "Ingresá el PIN personal de 4 dígitos.");
    return;
  }
  const button = $("#login-submit");
  button.disabled = true;
  $("#login-error").hidden = true;
  try {
    const result = await api("/session/login", {
      method: "POST",
      body: JSON.stringify({ name, pin }),
    });
    state.pendingLoginName = null;
    $("#login-form").reset();
    openAuthenticatedSession(result.user);
  } catch (error) {
    showError($("#login-error"), error.message);
    $("#login-pin").focus();
  } finally {
    button.disabled = false;
  }
}

function openAuthenticatedSession(name) {
  state.user = name;
  state.view = "personal";
  state.status = "active";
  updateStatusControls();
  $("#login-error").hidden = true;
  loginScreen.hidden = true;
  appScreen.hidden = false;
  $("#header-user").textContent = name;
  $("#header-avatar").textContent = initials(name);
  $("#welcome-title").textContent = `Hola, ${name.split(" ")[0]}`;
  setView("personal");
  void refreshClientWorks();
  state.notifications = [];
  notificationsInitialized = false;
  renderNotifications();
  void refreshNotifications(false);
  clearInterval(notificationTimer);
  notificationTimer = setInterval(() => void refreshNotifications(), 3000);
}

function clearSessionState() {
  taskFetchVersion += 1;
  clearInterval(notificationTimer);
  notificationTimer = undefined;
  state.user = null;
  state.tasks = [];
  state.notifications = [];
  notificationsInitialized = false;
  state.busy = false;
  renderNotifications();
  appScreen.hidden = true;
  $("#login-form").hidden = true;
  $("#user-list").hidden = false;
  state.pendingLoginName = null;
  $("#login-pin").value = "";
  loginScreen.hidden = false;
  $("#user-list button")?.focus();
}

async function endSession() {
  try {
    await fetch("/api/session/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("No se pudo invalidar la sesión en el servidor:", error);
  }
  clearSessionState();
}

async function restoreSession() {
  try {
    const result = await api("/session");
    openAuthenticatedSession(result.user);
  } catch {
    $("#user-list").hidden = false;
  }
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
    personal: { active: "Mis tareas activas", completed: "Mis tareas completadas" },
    global: { active: "Todas las tareas activas", completed: "Todas las tareas completadas" },
  };
  $("#tasks-title").textContent = labels[state.view][state.status];
}

function updateStatusControls() {
  $("#active-board-footer").hidden = state.status === "completed";
  $("#completed-board-footer").hidden = state.status !== "completed";
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
  const parts = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", year: "numeric" })
    .formatToParts(new Date(`${value.slice(0, 10)}T12:00:00`));
  const dateParts = Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value: partValue }) => [type, partValue]));
  return `${dateParts.day} de ${dateParts.month} del ${dateParts.year}`;
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderNotifications() {
  const list = $("#notification-list");
  const unreadCount = state.notifications.filter((notification) => !notification.readAt).length;
  const badge = $("#notification-count");
  badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  badge.hidden = unreadCount === 0;
  $("#notifications-button").setAttribute(
    "aria-label",
    unreadCount ? `Abrir notificaciones, ${unreadCount} sin leer` : "Abrir notificaciones",
  );
  list.replaceChildren();
  if (!state.notifications.length) {
    const empty = document.createElement("p");
    empty.className = "notification-empty";
    empty.textContent = "Todavía no tenés notificaciones.";
    list.append(empty);
    return;
  }
  for (const notification of state.notifications) {
    const item = document.createElement("article");
    item.className = `notification-item${notification.readAt ? "" : " is-unread"}`;
    const heading = document.createElement("div");
    heading.className = "notification-item-heading";
    const title = document.createElement("strong");
    title.textContent = `${notification.createdBy} te asignó una tarea`;
    const timestamp = document.createElement("time");
    timestamp.dateTime = notification.createdAt;
    timestamp.textContent = formatDateTime(notification.createdAt);
    heading.append(title, timestamp);
    const description = document.createElement("p");
    description.className = "notification-description";
    description.textContent = notification.description;
    item.append(heading, description);
    if (notification.clientWorkName) {
      const clientWork = document.createElement("span");
      clientWork.className = "client-work-badge";
      clientWork.textContent = notification.clientWorkName;
      item.append(clientWork);
    }
    if (!notification.readAt) {
      const markRead = document.createElement("button");
      markRead.type = "button";
      markRead.className = "notification-read-button";
      markRead.textContent = "Marcar como leída";
      markRead.addEventListener("click", () => void markNotificationRead(notification, markRead));
      item.append(markRead);
    }
    list.append(item);
  }
}

async function refreshNotifications(announce = true) {
  if (!state.user) return;
  try {
    const query = new URLSearchParams({ user: state.user });
    const result = await api(`/notifications?${query}`);
    const knownIds = new Set(state.notifications.map((notification) => notification.id));
    const newNotifications = notificationsInitialized && announce
      ? result.notifications.filter((notification) => !knownIds.has(notification.id))
      : [];
    const changed = result.notifications.length !== state.notifications.length
      || result.notifications.some((notification, index) => {
        const previous = state.notifications[index];
        return !previous || previous.id !== notification.id || previous.readAt !== notification.readAt;
      });
    state.notifications = result.notifications;
    notificationsInitialized = true;
    $("#notifications-error").hidden = true;
    if (changed) renderNotifications();
    if (newNotifications.length === 1) {
      const notification = newNotifications[0];
      showToast(`${notification.createdBy} te asignó: ${notification.description}${notification.clientWorkName ? ` · ${notification.clientWorkName}` : ""}`);
    } else if (newNotifications.length > 1) {
      showToast(`Tenés ${newNotifications.length} nuevas notificaciones de tareas.`);
    }
  } catch (error) {
    showError($("#notifications-error"), error.message);
  }
}

async function markNotificationRead(notification, button) {
  button.disabled = true;
  try {
    const result = await api(`/notifications/${encodeURIComponent(notification.id)}/read`, {
      method: "PATCH",
      body: JSON.stringify({ user: state.user }),
    });
    state.notifications = state.notifications.map((item) => item.id === notification.id ? result.notification : item);
    renderNotifications();
  } catch (error) {
    showError($("#notifications-error"), error.message);
    button.disabled = false;
  }
}

function renderTasks() {
  const list = $("#task-list");
  const pendingList = $("#pending-task-list");
  const inProgressList = $("#in-progress-task-list");
  const pendingTasks = state.tasks.filter((task) => task.status !== "in_progress" && task.status !== "completed");
  const inProgressTasks = state.tasks.filter((task) => task.status === "in_progress");
  list.replaceChildren();
  pendingList.replaceChildren();
  inProgressList.replaceChildren();
  const tasks = state.tasks;
  const isCompletedView = state.status === "completed";
  const taskLabel = isCompletedView ? "completada" : "activa";
  $("#task-count").textContent = `${tasks.length} ${tasks.length === 1 ? `tarea ${taskLabel}` : `tareas ${isCompletedView ? "completadas" : "activas"}`}`;
  updateStatusControls();
  $("#active-task-groups").hidden = isCompletedView || tasks.length === 0;
  list.hidden = !isCompletedView || tasks.length === 0;
  $("#pending-task-count").textContent = `${pendingTasks.length} ${pendingTasks.length === 1 ? "tarea" : "tareas"}`;
  $("#in-progress-task-count").textContent = `${inProgressTasks.length} ${inProgressTasks.length === 1 ? "tarea" : "tareas"}`;
  $("#pending-task-empty").hidden = pendingTasks.length > 0 || tasks.length === 0;
  $("#in-progress-task-empty").hidden = inProgressTasks.length > 0 || tasks.length === 0;
  $("#empty-state").hidden = state.busy || tasks.length > 0 || !$("#board-error").hidden;
  $("#empty-title").textContent = isCompletedView ? "Aún no hay tareas completadas" : "No hay tareas activas";
  $("#empty-description").textContent = isCompletedView
    ? "Las tareas terminadas aparecerán aquí."
    : "Cuando haya tareas activas, las vas a encontrar en Pendientes o En proceso.";
  $("#loading").hidden = !state.busy;

  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = isCompletedView ? "task-card is-completed" : `task-card${task.status === "in_progress" ? " is-in-progress" : ""}`;
    if (isCompletedView) {
      const badge = document.createElement("span");
      badge.className = "completed-badge";
      badge.textContent = "✓ Completada";
      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "task-status-toggle";
      reopen.textContent = "Volver a Pendiente";
      reopen.setAttribute("aria-label", `Reabrir como pendiente: ${task.description}`);
      reopen.addEventListener("click", () => requestTaskAction(task, reopen, "pending"));
      const statusControl = document.createElement("div");
      statusControl.className = "task-status-control";
      statusControl.append(badge, reopen);
      card.append(statusControl, createTaskDeleteButton(task));
    } else {
      const statusControl = document.createElement("div");
      statusControl.className = "task-status-control";
      if (task.status === "in_progress") {
        const statusBadge = document.createElement("span");
        statusBadge.className = "task-status-badge is-in-progress";
        statusBadge.textContent = "En proceso";
        statusControl.append(statusBadge);
      }
      const statusToggle = document.createElement("button");
      statusToggle.type = "button";
      statusToggle.className = `task-status-toggle${task.status === "pending" ? " is-start-action" : ""}`;
      const nextStatusLabel = task.status === "in_progress" ? "Cambiar a Pendiente" : "Empezar";
      statusToggle.textContent = nextStatusLabel;
      statusToggle.setAttribute("aria-label", `${nextStatusLabel}: ${task.description}`);
      statusToggle.addEventListener("click", () => requestTaskAction(
        task,
        statusToggle,
        task.status === "in_progress" ? "pending" : "in_progress",
      ));
      statusControl.append(statusToggle);
      const primaryActions = document.createElement("div");
      primaryActions.className = "task-primary-actions";
      primaryActions.append(statusControl);

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
      complete.addEventListener("click", () => requestTaskAction(task, complete, "completed"));
      primaryActions.append(complete);
      const secondaryActions = document.createElement("div");
      secondaryActions.className = "task-secondary-actions";
      secondaryActions.append(createTaskEditButton(task), createTaskDeleteButton(task));
      card.append(primaryActions, secondaryActions);
    }

    const body = document.createElement("div");
    body.className = "task-body";
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    body.append(description);
    if (task.clientWorkName) {
      const clientWork = document.createElement("span");
      clientWork.className = "client-work-badge";
      clientWork.textContent = task.clientWorkName;
      body.append(clientWork);
    }
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const created = document.createElement("span");
    created.textContent = `Creada el ${formatDate(task.createdAt)}${task.createdBy ? ` por ${task.createdBy}` : ""}`;
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
    body.append(meta, recipients);
    card.append(body);
    const targetList = isCompletedView ? list : task.status === "in_progress" ? inProgressList : pendingList;
    targetList.append(card);
  }
}

function createTaskEditButton(task) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-edit-button";
  button.textContent = "Editar";
  button.title = "Editar tarea";
  button.setAttribute("aria-label", `Editar tarea: ${task.description}`);
  button.addEventListener("click", () => openDialog(task));
  return button;
}

function createTaskDeleteButton(task) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-delete-button";
  button.textContent = "Eliminar";
  button.title = "Eliminar tarea";
  button.setAttribute("aria-label", `Eliminar tarea: ${task.description}`);
  button.addEventListener("click", () => requestTaskDeletion(task, button));
  return button;
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

function requestTaskAction(task, button, status) {
  const action = { type: "task-status", task, button, status };
  const isCompleted = status === "completed";
  const isReopening = task.status === "completed" && status === "pending";
  const title = isCompleted
    ? "¿Completar esta tarea?"
    : isReopening
      ? "¿Reabrir esta tarea?"
      : status === "in_progress"
        ? "¿Pasar a En proceso?"
        : "¿Cambiar a Pendiente?";
  const help = isCompleted
    ? "Al confirmarlo, la tarea se marcará como terminada y dejará de aparecer entre las activas."
    : isReopening
      ? "La tarea dejará de aparecer entre las completadas y volverá a Pendiente."
      : status === "in_progress"
        ? "La tarea seguirá en Activas, ahora identificada como En proceso."
        : "La tarea volverá a Pendiente y seguirá en el tablero de Activas.";
  showActionConfirmation(action, {
    title,
    description: task.description,
    help,
    cancel: isCompleted ? "Seguir pendiente" : isReopening ? "Mantener completada" : "Cancelar",
    confirm: isCompleted
      ? "Sí, completar"
      : isReopening
        ? "Sí, reabrir"
        : status === "in_progress"
          ? "Sí, pasar a En proceso"
          : "Sí, volver a Pendiente",
  });
}

function requestTaskDeletion(task, button) {
  showActionConfirmation({ type: "delete-task", task, button }, {
    title: "¿Estás seguro de eliminar esta tarea?",
    description: task.description,
    help: "La tarea se quitará de todos los tableros. Esta acción no se puede deshacer.",
    cancel: "Conservar tarea",
    confirm: "Sí, eliminar",
  });
}

function requestClientWorkDeletion(clientWork, button) {
  showActionConfirmation({ type: "delete-client-work", clientWork, button }, {
    title: "¿Eliminar este cliente / obra?",
    description: clientWork.name,
    help: "Se quitará de la lista y no se podrá asociar a nuevas tareas. Primero eliminá las tareas que todavía lo usan.",
    cancel: "Conservar",
    confirm: "Sí, eliminar",
  });
}

function showActionConfirmation(action, { title, description, help, cancel, confirm }) {
  pendingTaskAction = action;
  $("#completion-title").textContent = title;
  $("#completion-description").textContent = description;
  $("#completion-help").textContent = help;
  $("#cancel-completion").textContent = cancel;
  $("#confirm-completion").textContent = confirm;
  $("#confirm-completion").classList.toggle("is-destructive", action.type.startsWith("delete-"));
  $("#confirm-completion").disabled = false;
  completionDialog.showModal();
}

async function updateTaskStatus(task, button, status) {
  button.disabled = true;
  try {
    const result = await api(`/tasks/${encodeURIComponent(task.id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    state.tasks = state.status === "completed"
      ? state.tasks.filter((item) => item.id !== task.id)
      : state.tasks.map((item) => item.id === task.id ? result.task : item);
    renderTasks();
    const message = task.status === "completed"
      ? "Tarea reabierta como pendiente."
      : status === "in_progress"
        ? "Tarea en proceso."
        : "Tarea pendiente.";
    showToast(message);
  } catch (error) {
    showToast(error.message, true);
    await refreshTasks();
  }
}

async function deleteTask(task, button) {
  button.disabled = true;
  try {
    await api(`/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    renderTasks();
    showToast("Tarea eliminada.");
  } catch (error) {
    showToast(error.message, true);
    await refreshTasks();
  }
}

async function completeTask(task, button) {
  taskFetchVersion += 1;
  state.busy = false;
  button.disabled = true;
  state.tasks = state.tasks.filter((item) => item.id !== task.id);
  renderTasks();
  try {
    await api(`/tasks/${encodeURIComponent(task.id)}/complete`, {
      method: "PATCH",
    });
    showToast("¡Tarea completada!");
    if (state.status === "completed") await refreshTasks();
  } catch (error) {
    showToast(error.message, true);
    await refreshTasks();
  }
}

async function confirmTaskAction() {
  if (!pendingTaskAction) return;
  const action = pendingTaskAction;
  $("#confirm-completion").disabled = true;
  completionDialog.close();
  if (action.type === "delete-task") await deleteTask(action.task, action.button);
  else if (action.type === "delete-client-work") await deleteClientWork(action.clientWork, action.button);
  else if (action.status === "completed") await completeTask(action.task, action.button);
  else await updateTaskStatus(action.task, action.button, action.status);
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

function openDialog(task = null) {
  editingTaskId = task?.id || null;
  $("#form-error").hidden = true;
  $("#task-form").reset();
  $("#save-task").disabled = false;
  $("#dialog-eyebrow").textContent = task ? "EDITAR TAREA" : "NUEVA TAREA";
  $("#dialog-title").textContent = task ? "Actualizá la tarea" : "¿Qué hay que hacer?";
  $("#save-task").textContent = task ? "Guardar cambios" : "Crear tarea";
  $("#description").value = task?.description || "";
  $("#due-date").value = task?.dueDate || "";
  const clientWorkSelect = $("#client-work");
  clientWorkSelect.replaceChildren(new Option("Sin cliente / obra", ""));
  for (const clientWork of state.clientWorks) {
    clientWorkSelect.add(new Option(clientWork.name, clientWork.id));
  }
  clientWorkSelect.value = task?.clientWorkId || "";
  $("#recipient-list").replaceChildren(...state.users.map((name) => {
    const label = document.createElement("label");
    label.className = "recipient-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "recipients";
    checkbox.value = name;
    checkbox.checked = task ? task.recipients.includes(name) : name === state.user;
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
  const taskId = editingTaskId;
  const isEditing = Boolean(taskId);
  button.disabled = true;
  $("#form-error").hidden = true;
  try {
    await api(isEditing ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify({
        description,
        recipients,
        dueDate: $("#due-date").value || null,
        clientWorkId: $("#client-work").value || null,
      }),
    });
    if (!isEditing) {
      state.status = "active";
      updateStatusControls();
      updateTasksTitle();
    }
    dialog.close();
    showToast(isEditing ? "Tarea actualizada." : "Tarea creada.");
    await refreshNotifications();
    await refreshTasks();
  } catch (error) {
    showError($("#form-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

function renderClientWorks() {
  const list = $("#client-work-list");
  list.replaceChildren();
  if (!state.clientWorks.length) {
    const empty = document.createElement("p");
    empty.className = "client-work-empty";
    empty.textContent = "Todavía no hay clientes u obras cargados.";
    list.append(empty);
    return;
  }
  for (const clientWork of state.clientWorks) {
    const item = document.createElement("article");
    item.className = "client-work-item";
    const name = document.createElement("h3");
    name.textContent = clientWork.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-delete-button client-work-delete";
    remove.textContent = "Eliminar";
    remove.setAttribute("aria-label", `Eliminar cliente / obra: ${clientWork.name}`);
    remove.addEventListener("click", () => requestClientWorkDeletion(clientWork, remove));
    const heading = document.createElement("div");
    heading.className = "client-work-item-heading";
    heading.append(name, remove);
    item.append(heading);
    if (clientWork.description) {
      const description = document.createElement("p");
      description.textContent = clientWork.description;
      item.append(description);
    }
    list.append(item);
  }
}

async function refreshClientWorks() {
  try {
    const result = await api("/client-works");
    state.clientWorks = result.clientWorks;
    renderClientWorks();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function createClientWork(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#save-client-work");
  button.disabled = true;
  $("#client-works-error").hidden = true;
  try {
    const result = await api("/client-works", {
      method: "POST",
      body: JSON.stringify({
        name: $("#client-work-name").value.trim(),
        description: $("#client-work-description").value.trim(),
      }),
    });
    state.clientWorks.push(result.clientWork);
    renderClientWorks();
    form.reset();
    clientWorksDialog.close();
    showToast("Cliente / obra agregado.");
  } catch (error) {
    showError($("#client-works-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteClientWork(clientWork, button) {
  button.disabled = true;
  $("#client-works-error").hidden = true;
  try {
    await api(`/client-works/${encodeURIComponent(clientWork.id)}`, { method: "DELETE" });
    state.clientWorks = state.clientWorks.filter((item) => item.id !== clientWork.id);
    renderClientWorks();
    showToast("Cliente / obra eliminado.");
  } catch (error) {
    showError($("#client-works-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

$("#logout-button").addEventListener("click", () => void endSession());
$("#login-form").addEventListener("submit", (event) => void startSession(event));
$("#login-cancel").addEventListener("click", () => {
  state.pendingLoginName = null;
  $("#login-form").reset();
  $("#login-form").hidden = true;
  $("#user-list").hidden = false;
  $("#login-error").hidden = true;
});
$("#personal-view").addEventListener("click", () => setView("personal"));
$("#global-view").addEventListener("click", () => setView("global"));
$("#active-tasks-button").addEventListener("click", () => setStatus("active"));
$("#completed-tasks-button").addEventListener("click", () => setStatus("completed"));
$("#add-task-button").addEventListener("click", () => openDialog());
$("#notifications-button").addEventListener("click", () => {
  $("#notifications-error").hidden = true;
  renderNotifications();
  notificationsDialog.showModal();
  void refreshNotifications();
});
$("#client-works-button").addEventListener("click", () => {
  $("#client-works-error").hidden = true;
  renderClientWorks();
  clientWorksDialog.showModal();
  $("#client-work-name").focus();
});
$("#close-dialog").addEventListener("click", () => dialog.close());
$("#cancel-dialog").addEventListener("click", () => dialog.close());
$("#task-form").addEventListener("submit", (event) => void createTask(event));
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
$("#client-work-form").addEventListener("submit", (event) => void createClientWork(event));
$("#cancel-client-works").addEventListener("click", () => clientWorksDialog.close());
$("#close-client-works").addEventListener("click", () => clientWorksDialog.close());
clientWorksDialog.addEventListener("click", (event) => {
  if (event.target === clientWorksDialog) clientWorksDialog.close();
});
$("#cancel-completion").addEventListener("click", () => completionDialog.close());
$("#close-completion").addEventListener("click", () => completionDialog.close());
$("#confirm-completion").addEventListener("click", () => void confirmTaskAction());
$("#close-notifications").addEventListener("click", () => notificationsDialog.close());
notificationsDialog.addEventListener("click", (event) => {
  if (event.target === notificationsDialog) notificationsDialog.close();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.user) void refreshNotifications();
});
completionDialog.addEventListener("click", (event) => {
  if (event.target === completionDialog) completionDialog.close();
});
completionDialog.addEventListener("close", () => {
  pendingTaskAction = null;
});

renderUsers();
void loadUsers();
void restoreSession();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .catch((error) => console.error("No se pudo registrar la aplicación instalable:", error));
}

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const USERS = new Set([
  "Pamela Pérez",
  "Nataniel Goyechea",
  "David Maglione",
  "Alen García",
  "Roberto Martin",
  "DIEC SAS",
]);
const STATUS_LABELS = {
  pending: "Pendiente",
  in_progress: "En proceso",
  completed: "Completada",
};

function assertEnvironment() {
  const required = ["AZURE_SQL_SERVER", "AZURE_SQL_DATABASE", "AZURE_SQL_USER", "AZURE_SQL_PASSWORD"];
  const missing = required.filter((key) => !process.env[key] || process.env[key].startsWith("your-"));
  if (missing.length) throw new Error(`Configura primero las variables: ${missing.join(", ")}.`);
}

async function loadRecords(fileName, property) {
  const parsed = JSON.parse(await readFile(path.join(ROOT, "data", fileName), "utf8"));
  if (!Array.isArray(parsed[property])) throw new Error(`${fileName} no contiene una lista ${property} válida.`);
  return parsed[property];
}

function assertUser(name, field) {
  if (name && !USERS.has(name)) throw new Error(`El usuario de ${field} no está en dbo.Usuarios: ${name}.`);
}

assertEnvironment();
const [clients, tasks, notifications] = await Promise.all([
  loadRecords("client-works.json", "clientWorks"),
  loadRecords("tasks.json", "tasks"),
  loadRecords("notifications.json", "notifications"),
]);
const liveTasks = tasks.filter((task) => task.status !== "deleted");
const taskIds = new Set(liveTasks.map((task) => task.id));
const referencedClientIds = new Set(liveTasks.map((task) => task.clientWorkId).filter(Boolean));
const clientsToImport = clients.filter((client) => client.status !== "deleted" || referencedClientIds.has(client.id));
const clientIds = new Set(clientsToImport.map((client) => client.id));
const notificationsToImport = notifications.filter((notification) => notification.status !== "deleted"
  && taskIds.has(notification.taskId));

for (const task of liveTasks) {
  if (!STATUS_LABELS[task.status]) throw new Error(`Estado desconocido en tarea ${task.id}.`);
  assertUser(task.createdBy, `la tarea ${task.id}`);
  assertUser(task.completedBy, `la finalización de la tarea ${task.id}`);
  if (!Array.isArray(task.recipients) || task.recipients.some((recipient) => !USERS.has(recipient))) {
    throw new Error(`Destinatarios inválidos en la tarea ${task.id}.`);
  }
  if (task.clientWorkId && !clientIds.has(task.clientWorkId)) {
    throw new Error(`Falta el cliente/obra asociado a la tarea ${task.id}; no se modificaron los JSON originales.`);
  }
}
for (const notification of notificationsToImport) {
  assertUser(notification.recipient, `la notificación ${notification.id}`);
  const task = liveTasks.find((item) => item.id === notification.taskId);
  const author = notification.createdBy || task?.createdBy;
  if (!author) throw new Error(`La notificación ${notification.id} no tiene autor. No se modificaron los JSON originales.`);
  assertUser(author, `la autoría de la notificación ${notification.id}`);
}

const pool = await new sql.ConnectionPool({
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 10000,
  requestTimeout: 30000,
}).connect();
const transaction = new sql.Transaction(pool);
let transactionStarted = false;

try {
  const counts = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.Clientes_Obras) AS Clients,
      (SELECT COUNT(*) FROM dbo.Tareas) AS Tasks,
      (SELECT COUNT(*) FROM dbo.Notificaciones) AS Notifications;
  `);
  const existing = counts.recordset[0];
  if (existing.Clients || existing.Tasks || existing.Notifications) {
    throw new Error("La migración requiere tablas vacías. No se modificó ningún registro.");
  }

  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  transactionStarted = true;
  for (const client of clientsToImport) {
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, client.id)
      .input("name", sql.NVarChar(150), client.name)
      .input("description", sql.NVarChar(500), client.description || null)
      .input("createdAt", sql.DateTimeOffset, new Date(client.createdAt))
      .query(`
        INSERT INTO dbo.Clientes_Obras (ClientWorkId, Name, Description, CreatedAt)
        VALUES (@id, @name, @description, @createdAt);
      `);
  }
  for (const task of liveTasks) {
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, task.id)
      .input("description", sql.NVarChar(1000), task.description)
      .input("recipients", sql.NVarChar(sql.MAX), JSON.stringify(task.recipients))
      .input("createdBy", sql.NVarChar(100), task.createdBy || null)
      .input("createdAt", sql.DateTimeOffset, new Date(task.createdAt))
      .input("clientWorkId", sql.UniqueIdentifier, task.clientWorkId || null)
      .input("status", sql.NVarChar(20), STATUS_LABELS[task.status])
      .input("dueDate", sql.Date, task.dueDate ? new Date(`${task.dueDate}T00:00:00.000Z`) : null)
      .input("completedAt", sql.DateTimeOffset, task.completedAt ? new Date(task.completedAt) : null)
      .input("completedBy", sql.NVarChar(100), task.completedBy || null)
      .query(`
        INSERT INTO dbo.Tareas
          (TaskId, Description, Recipients, CreatedBy, CreatedAt, ClientWorkId,
           Estado, DueDate, CompletedAt, CompletedBy)
        VALUES
          (@id, @description, @recipients, @createdBy, @createdAt, @clientWorkId,
           @status, @dueDate, @completedAt, @completedBy);
      `);
  }
  for (const notification of notificationsToImport) {
    const task = liveTasks.find((item) => item.id === notification.taskId);
    if (!task) continue;
    const assignedBy = notification.createdBy || task.createdBy;
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, notification.id)
      .input("taskId", sql.UniqueIdentifier, notification.taskId)
      .input("recipient", sql.NVarChar(100), notification.recipient)
      .input("createdBy", sql.NVarChar(100), assignedBy)
      .input("description", sql.NVarChar(1000), notification.description || task.description)
      .input("clientWorkName", sql.NVarChar(150), notification.clientWorkName || null)
      .input("createdAt", sql.DateTimeOffset, new Date(notification.createdAt))
      .input("readAt", sql.DateTimeOffset, notification.readAt ? new Date(notification.readAt) : null)
      .query(`
        INSERT INTO dbo.Notificaciones
          (NotificationId, TaskId, Recipient, CreatedBy, Description, ClientWorkName, CreatedAt, ReadAt)
        VALUES
          (@id, @taskId, @recipient, @createdBy, @description, @clientWorkName, @createdAt, @readAt);
      `);
  }
  await transaction.commit();
  transactionStarted = false;
  console.info(`Migración completada: ${clientsToImport.length} clientes/obras, ${liveTasks.length} tareas y ${notificationsToImport.length} notificaciones.`);
  console.info("Los archivos JSON originales se conservaron intactos.");
} catch (error) {
  if (transactionStarted && transaction._aborted !== true) await transaction.rollback();
  throw error;
} finally {
  await pool.close();
}

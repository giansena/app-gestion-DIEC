SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.Usuarios', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.Usuarios (
            UserId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Usuarios PRIMARY KEY,
            Name NVARCHAR(100) NOT NULL,
            Email NVARCHAR(254) NULL,
            CONSTRAINT UQ_Usuarios_Name UNIQUE (Name)
        );
    END;

    INSERT INTO dbo.Usuarios (Name, Email)
    SELECT seed.Name, NULL
    FROM (VALUES
        (N'Pamela Pérez'),
        (N'Nataniel Goyechea'),
        (N'David Maglione'),
        (N'Alen García'),
        (N'Roberto Martin'),
        (N'DIEC SAS')
    ) AS seed(Name)
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.Usuarios AS currentUser WHERE currentUser.Name = seed.Name
    );

    IF OBJECT_ID(N'dbo.Clientes_Obras', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.Clientes_Obras (
            ClientWorkId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Clientes_Obras PRIMARY KEY,
            Name NVARCHAR(150) NOT NULL,
            Description NVARCHAR(500) NULL,
            CreatedAt DATETIMEOFFSET(0) NOT NULL
                CONSTRAINT DF_Clientes_Obras_CreatedAt DEFAULT SYSUTCDATETIME()
        );
    END;

    IF OBJECT_ID(N'dbo.Tareas', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.Tareas (
            TaskId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Tareas PRIMARY KEY,
            Description NVARCHAR(1000) NOT NULL,
            Recipients NVARCHAR(MAX) NOT NULL,
            CreatedBy NVARCHAR(100) NULL,
            CreatedAt DATETIMEOFFSET(0) NOT NULL
                CONSTRAINT DF_Tareas_CreatedAt DEFAULT SYSUTCDATETIME(),
            ClientWorkId UNIQUEIDENTIFIER NULL,
            Estado NVARCHAR(20) NOT NULL
                CONSTRAINT DF_Tareas_Estado DEFAULT N'Pendiente',
            DueDate DATE NULL,
            CompletedAt DATETIMEOFFSET(0) NULL,
            CompletedBy NVARCHAR(100) NULL
        );
    END;

    IF COL_LENGTH(N'dbo.Tareas', N'CreatedBy') IS NULL
        ALTER TABLE dbo.Tareas ADD CreatedBy NVARCHAR(100) NULL;
    IF COL_LENGTH(N'dbo.Tareas', N'ClientWorkId') IS NULL
        ALTER TABLE dbo.Tareas ADD ClientWorkId UNIQUEIDENTIFIER NULL;
    IF COL_LENGTH(N'dbo.Tareas', N'DueDate') IS NULL
        ALTER TABLE dbo.Tareas ADD DueDate DATE NULL;
    IF COL_LENGTH(N'dbo.Tareas', N'CompletedAt') IS NULL
        ALTER TABLE dbo.Tareas ADD CompletedAt DATETIMEOFFSET(0) NULL;
    IF COL_LENGTH(N'dbo.Tareas', N'CompletedBy') IS NULL
        ALTER TABLE dbo.Tareas ADD CompletedBy NVARCHAR(100) NULL;
    IF COL_LENGTH(N'dbo.Tareas', N'Recipients') IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID(N'dbo.Tareas')
             AND name = N'Recipients'
             AND max_length <> -1
       )
        ALTER TABLE dbo.Tareas ALTER COLUMN Recipients NVARCHAR(MAX) NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Tareas_Recipients_Json')
        ALTER TABLE dbo.Tareas WITH CHECK
        ADD CONSTRAINT CK_Tareas_Recipients_Json CHECK (ISJSON(Recipients) = 1);
    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Tareas_Estado')
        ALTER TABLE dbo.Tareas WITH CHECK
        ADD CONSTRAINT CK_Tareas_Estado CHECK (Estado IN (N'Pendiente', N'En proceso', N'Completada'));
    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Tareas_Clientes_Obras')
        ALTER TABLE dbo.Tareas WITH CHECK
        ADD CONSTRAINT FK_Tareas_Clientes_Obras
        FOREIGN KEY (ClientWorkId) REFERENCES dbo.Clientes_Obras (ClientWorkId);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Tareas') AND name = N'IX_Tareas_Estado_CreatedAt')
        CREATE INDEX IX_Tareas_Estado_CreatedAt ON dbo.Tareas (Estado, CreatedAt DESC);

    IF OBJECT_ID(N'dbo.Notificaciones', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.Notificaciones (
            NotificationId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Notificaciones PRIMARY KEY,
            TaskId UNIQUEIDENTIFIER NOT NULL,
            Recipient NVARCHAR(100) NOT NULL,
            CreatedBy NVARCHAR(100) NOT NULL,
            Description NVARCHAR(1000) NOT NULL,
            ClientWorkName NVARCHAR(150) NULL,
            CreatedAt DATETIMEOFFSET(0) NOT NULL
                CONSTRAINT DF_Notificaciones_CreatedAt DEFAULT SYSUTCDATETIME(),
            ReadAt DATETIMEOFFSET(0) NULL
        );
    END;

    IF COL_LENGTH(N'dbo.Notificaciones', N'ReadAt') IS NULL
        ALTER TABLE dbo.Notificaciones ADD ReadAt DATETIMEOFFSET(0) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Notificaciones_Tareas')
        ALTER TABLE dbo.Notificaciones WITH CHECK
        ADD CONSTRAINT FK_Notificaciones_Tareas
        FOREIGN KEY (TaskId) REFERENCES dbo.Tareas (TaskId) ON DELETE CASCADE;
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Notificaciones') AND name = N'IX_Notificaciones_Recipient_CreatedAt')
        CREATE INDEX IX_Notificaciones_Recipient_CreatedAt
            ON dbo.Notificaciones (Recipient, CreatedAt DESC);

    IF OBJECT_ID(N'dbo.RecordatoriosEmail', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.RecordatoriosEmail (
            UserId INT NOT NULL,
            ReminderDate DATE NOT NULL,
            Status NVARCHAR(20) NOT NULL,
            AttemptedAt DATETIMEOFFSET(0) NOT NULL,
            SentAt DATETIMEOFFSET(0) NULL,
            LastError NVARCHAR(1000) NULL,
            CONSTRAINT PK_RecordatoriosEmail PRIMARY KEY (UserId, ReminderDate),
            CONSTRAINT CK_RecordatoriosEmail_Status
                CHECK (Status IN (N'Enviando', N'Enviado', N'Fallido')),
            CONSTRAINT FK_RecordatoriosEmail_Usuarios
                FOREIGN KEY (UserId) REFERENCES dbo.Usuarios (UserId)
        );
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

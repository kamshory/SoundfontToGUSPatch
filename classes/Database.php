<?php

class Database
{
    private static $instance = null;
    private $pdo;

    private function __construct()
    {
        $dbPath = __DIR__ . '/../data/editor.sqlite';
        $dbDir = dirname($dbPath);

        if (!is_dir($dbDir)) {
            mkdir($dbDir, 0777, true);
        }

        $this->pdo = new PDO('sqlite:' . $dbPath);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

        $this->createTables();
    }

    public static function getInstance()
    {
        if (self::$instance === null) {
            self::$instance = new Database();
        }
        return self::$instance;
    }

    public function getConnection()
    {
        return $this->pdo;
    }

    private function createTables()
    {
        $commands = [
            'CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                directory_path TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )',
            'CREATE TABLE IF NOT EXISTS patches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                file_name TEXT NOT NULL,
                patch_type TEXT NOT NULL, -- "tone" or "drum"
                program_num INTEGER NOT NULL,
                bank_num INTEGER NOT NULL,
                preset_name TEXT,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )'
        ];

        foreach ($commands as $command) {
            $this->pdo->exec($command);
        }
    }

    public function createProject($name, $directoryPath)
    {
        $stmt = $this->pdo->prepare('INSERT INTO projects (name, directory_path) VALUES (?, ?)');
        $stmt->execute([$name, $directoryPath]);
        return $this->pdo->lastInsertId();
    }

    public function addPatchToProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName)
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO patches (project_id, file_name, patch_type, program_num, bank_num, preset_name) 
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$projectId, $fileName, $patchType, $programNum, $bankNum, $presetName]);
        return $this->pdo->lastInsertId();
    }

    /**
     * Updates an existing patch or inserts a new one if it doesn't exist.
     * Also returns the old filename if an update occurred, for cleanup purposes.
     *
     * @param int $projectId
     * @param string $fileName
     * @param string $patchType
     * @param int $programNum
     * @param int $bankNum
     * @param string $presetName
     * @return string|null The old filename if a patch was updated, otherwise null.
     */
    public function upsertPatchForProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName)
    {
        $stmt = $this->pdo->prepare('SELECT id, file_name FROM patches WHERE project_id = ? AND program_num = ? AND patch_type = ?');
        $stmt->execute([$projectId, $programNum, $patchType]);
        $existing = $stmt->fetch();

        if ($existing) {
            $stmt = $this->pdo->prepare('UPDATE patches SET file_name = ?, preset_name = ?, bank_num = ? WHERE id = ?');
            $stmt->execute([$fileName, $presetName, $bankNum, $existing['id']]);
            return $existing['file_name']; // Return old filename for deletion
        } else {
            $this->addPatchToProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName);
            return null; // No old file to delete
        }
    }
}
<?php
/**
 * SoundfontToGusPatch Class
 *
 * Converts a SoundFont 2 (.sf2) file into a set of compatible GUS Patch (.pat)
 * files and a timidity.cfg configuration file.
 *
 * @version 1.0
 * @author Kamshory
 */
class Database
{
    /**
     * @var Database $intance
     */
    private static $instance = null;

    /**
     * @var PDO $pdo
     */
    private $pdo;

    /**
     * Constructor
     */
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

    /**
     * Get instance
     */
    public static function getInstance()
    {
        if (self::$instance === null) {
            self::$instance = new Database();
        }
        return self::$instance;
    }

    /**
     * Get connection
     */
    public function getConnection()
    {
        return $this->pdo;
    }

    /**
     * Create tables
     */
    private function createTables()
    {
        $commands = [
            'CREATE TABLE IF NOT EXISTS project (
                project_id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                directory_path TEXT NOT NULL UNIQUE,
                source_path TEXT,
                time_create DATETIME DEFAULT CURRENT_TIMESTAMP,
                time_update DATETIME DEFAULT CURRENT_TIMESTAMP
            )',
            'CREATE TABLE IF NOT EXISTS patch (
                patch_id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                file_name TEXT NOT NULL,
                patch_type TEXT NOT NULL, -- "tone" or "drum"
                program_num INTEGER NOT NULL,
                bank_num INTEGER NOT NULL,
                preset_name TEXT,
                FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
            )'
        ];

        foreach ($commands as $command) {
            $this->pdo->exec($command);
        }
    }

    /**
     * Create project
     * 
     * @param string $name Project name
     * @param string $directoryPath Directory path
     */
    public function createProject($name, $directoryPath)
    {
        $stmt = $this->pdo->prepare('INSERT INTO project (name, directory_path) VALUES (?, ?)');
        $stmt->execute([$name, $directoryPath]);
        return $this->pdo->lastInsertId();
    }

    /**
     * Add patch to project
     * 
     * @param int $projectId Project ID
     * @param string $fileName File name
     * @param string $patchType Patch type
     * @param int $programNum Program number
     * @param int $bankNum Bank number
     * @param string $presetName Preset name
     * @return int
     */
    public function addPatchToProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName)
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO patch (project_id, file_name, patch_type, program_num, bank_num, preset_name) 
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$projectId, $fileName, $patchType, $programNum, $bankNum, $presetName]);
        return $this->pdo->lastInsertId();
    }

    /**
     * Updates an existing patch or inserts a new one if it doesn't exist.
     * Also returns the old filename if an update occurred, for cleanup purposes.
     *
     * @param int $projectId Project ID
     * @param string $fileName File name
     * @param string $patchType Patch type
     * @param int $programNum Program number
     * @param int $bankNum Bank number
     * @param string $presetName Preset name
     * @return string|null The old filename if a patch was updated, otherwise null.
     */
    public function upsertPatchForProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName)
    {
        $stmt = $this->pdo->prepare('SELECT patch_id, project_id, file_name FROM patch WHERE project_id = ? AND program_num = ? AND patch_type = ?');
        $stmt->execute([$projectId, $programNum, $patchType]);
        $existing = $stmt->fetch();

        if ($existing) {
            $stmt = $this->pdo->prepare('UPDATE patch SET file_name = ?, preset_name = ?, bank_num = ? WHERE patch_id = ?');
            $stmt->execute([$fileName, $presetName, $bankNum, $existing['patch_id']]);
            return $existing['file_name']; // Return old filename for deletion
        } else {
            $this->addPatchToProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName);
            return null; // No old file to delete
        }
    }
}
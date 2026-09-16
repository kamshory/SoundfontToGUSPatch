<?php

/**
 * SoundfontToGusPatch Class
 *
 * Converts a SoundFont 2 (.sf2) file into a set of compatible GUS Patch (.pat)
 * files and a timidity.cfg configuration file.
 *
 * @version 1.0
 * @author Gemini Code Assist
 */
class SoundfontToGusPatch
{
    /** @var string */
    private $sf2FilePath;
    /** @var string */
    private $outputDir;
    /** @var resource|false */
    private $fp;
    /** @var array */
    private $pdtaChunks = [];
    /** @var int */
    private $smplOffset = 0;
    /** @var array */
    private $shdr_list = [];
    /** @var array */
    private $inst_list = [];
    /** @var array */
    private $phdr_list = [];
    /** @var array */
    private $timidityMap = [];
    /** @var int */
    private $convertedCount = 0;
    /** @var callable */
    private $logger;
    /** @var int|null */
    private $projectId = null;
    /** @var Database|null */
    private $db = null;

    /**
     * Main conversion function.
     *
     * @param string $sourceFilePath Path to the source .sf2 file.
     * @param string $outputDirectory Path to the output directory.
     * @throws \Exception If an error occurs during the conversion process.
     */
    public function convert($sourceFilePath, $outputDirectory)
    {
        $this->initialize($sourceFilePath, $outputDirectory);
        try {
            $this->parseRiffAndFindChunks();
            $this->parsePdtaSubChunks();
            $this->processPresetsAndGeneratePatches();
            $this->writeTimidityConfig();
            $this->log("\nDone! Successfully converted {$this->convertedCount} .pat files.");
        } finally {
            if (is_resource($this->fp)) fclose($this->fp);
        }
    }

    /**
     * Sets a custom logging function.
     *
     * @param callable $logger The function to use for logging. It should accept one string argument.
     */
    public function setLogger($logger)       
    { 
        $this->logger = $logger; 
    }

    /**
     * Sets the project ID for database logging.
     * @param int $projectId
     */
    public function setProjectId($projectId) 
    { 
        $this->projectId = $projectId; 
    }

    /**
     * Sets the database manager instance.
     * @param Database $db
     */
    public function setDatabase($db) 
    { 
        $this->db = $db; 
    }

    /**
     * Logs a message using the configured logger.
     *
     * @param string $message The message to log.
     */
    private function log($message)
    {
        if (is_callable($this->logger)) call_user_func($this->logger, $message);
    }

    /**
     * @param string $sourceFilePath
     * @param string $outputDirectory
     * @throws \Exception
     */
    private function initialize($sourceFilePath, $outputDirectory)
    {
        if (!file_exists($sourceFilePath)) throw new \Exception("SF2 file not found: '{$sourceFilePath}'.");
        $this->sf2FilePath = $sourceFilePath;
        $this->outputDir = $outputDirectory;
        if (!isset($this->logger)) {
            $this->setLogger(function ($m) { echo $m . "\n"; });
        }
        $this->log("Reading SF2 file: " . basename($this->sf2FilePath) . "...");
        $this->fp = fopen($this->sf2FilePath, 'rb');
        if (!$this->fp) throw new \Exception("Failed to open SF2 file.");
    }

    private function parseRiffAndFindChunks()
    {
        $riffHeader = fread($this->fp, 12);
        if (substr($riffHeader, 0, 4) !== 'RIFF' || substr($riffHeader, 8, 4) !== 'sfbk') {
            throw new \Exception("Not a valid SF2 file format.");
        }

        while (!feof($this->fp)) {
            $chunkHeader = fread($this->fp, 8);
            if (strlen($chunkHeader) < 8) break;

            $id   = substr($chunkHeader, 0, 4);
            $size = unpack('V', substr($chunkHeader, 4, 4))[1];

            if ($id === 'LIST') {
                $type = fread($this->fp, 4);
                $listContent = fread($this->fp, $size - 4);
                $listContentStart = ftell($this->fp) - strlen($listContent);

                if ($type === 'sdta') {
                    $offset = 0;
                    while ($offset < strlen($listContent)) {
                        if ($offset + 8 > strlen($listContent)) break;
                        $subId   = substr($listContent, $offset, 4);
                        $subSize = unpack('V', substr($listContent, $offset + 4, 4))[1];
                        if ($subId === 'smpl') {
                            $this->smplOffset = $listContentStart + $offset + 8;
                            break;
                        }
                        $offset += 8 + $subSize;
                        if ($subSize % 2 !== 0) $offset++;
                    }
                } elseif ($type === 'pdta') {
                    $offset = 0;
                    while ($offset < strlen($listContent)) {
                        $subId   = substr($listContent, $offset, 4);
                        $subSize = unpack('V', substr($listContent, $offset + 4, 4))[1];
                        $this->pdtaChunks[$subId] = substr($listContent, $offset + 8, $subSize);
                        $offset += 8 + $subSize;
                        if ($subSize % 2 !== 0) $offset++;
                    }
                }
            } else {
                fseek($this->fp, $size, SEEK_CUR);
            }
            if ($size % 2 !== 0) fseek($this->fp, 1, SEEK_CUR);
        }

        foreach (['phdr','pbag','pgen','inst','ibag','igen','shdr'] as $c) {
            if (!isset($this->pdtaChunks[$c])) throw new \Exception("Chunk '{$c}' not found.");
        }
        if ($this->smplOffset === 0) throw new \Exception("Chunk 'sdta' not found.");
    }

    private function parsePdtaSubChunks()
    {
        $this->shdr_list = $this->parseStructArray($this->pdtaChunks['shdr'], 46);
        $this->inst_list = $this->parseStructArray($this->pdtaChunks['inst'], 22);
        $this->phdr_list = $this->parseStructArray($this->pdtaChunks['phdr'], 38);
        $this->log("Read " . count($this->phdr_list) . " Presets, "
                 . count($this->inst_list) . " Instruments, "
                 . count($this->shdr_list) . " Samples.\n");
    }

    /**
     * @param string $data
     * @param int $struct_size
     * @return array
     */
    private function parseStructArray($data, $struct_size)
    {
        $items = [];
        for ($i = 0; $i <= strlen($data) - $struct_size; $i += $struct_size) {
            $items[] = substr($data, $i, $struct_size);
        }
        return $items;
    }

    // ==================================================================
    // MAIN LOOP
    // ==================================================================
    private function processPresetsAndGeneratePatches()
    {
        $toneDir = $this->outputDir . "/tone";
        $drumDir = $this->outputDir . "/drum";
        if (!is_dir($toneDir)) mkdir($toneDir, 0777, true);
        if (!is_dir($drumDir)) mkdir($drumDir, 0777, true);

        $numPbagEntries = (int)(strlen($this->pdtaChunks['pbag']) / 4);
        $this->timidityMap = [];

        foreach ($this->phdr_list as $pIdx => $p) {
            $presetName = rtrim(substr($p, 0, 20), "\0");
            $program    = unpack('v', substr($p, 20, 2))[1];
            $bank       = unpack('v', substr($p, 22, 2))[1];
            $pbag_start = unpack('v', substr($p, 24, 2))[1];

            $isDrum = ($bank == 128);
            if ($bank != 0 && !$isDrum) continue;

            $pbag_end = isset($this->phdr_list[$pIdx + 1])
                ? unpack('v', substr($this->phdr_list[$pIdx + 1], 24, 2))[1]
                : $numPbagEntries - 1;

            $zones = $this->parsePresetZones($pbag_start, $pbag_end);
            if (empty($zones)) continue;

            if ($isDrum) {
                $this->writeDrumPatches($zones, $program, $presetName, $drumDir);
            } else {
                $this->writeTonePatch($zones, $program, $bank, $presetName, $toneDir);
            }
        }
    }

    /**
     * Baca semua preset zone dari range pbag, kembalikan array:
     *   [ ['low'=>, 'high'=>, 'instId'=>, 'instName'=>], ... ]
     */
    private function parsePresetZones($pbagStart, $pbagEnd)
    {
        $zones = [];
        for ($i = $pbagStart; $i < $pbagEnd; $i++) {
            $pgenStart = unpack('v', substr($this->pdtaChunks['pbag'], $i * 4, 2))[1];
            $nextOffset = ($i + 1) * 4;
            $pgenEnd = ($nextOffset < strlen($this->pdtaChunks['pbag']))
                ? unpack('v', substr($this->pdtaChunks['pbag'], $nextOffset, 2))[1]
                : (int)(strlen($this->pdtaChunks['pgen']) / 4);

            $keyLow = 0; $keyHigh = 127; $instId = null;

            for ($j = $pgenStart; $j < $pgenEnd; $j++) {
                $gen = unpack('v', substr($this->pdtaChunks['pgen'], $j * 4, 2))[1];
                if ($gen == 43) {
                    $keyLow  = ord(substr($this->pdtaChunks['pgen'], $j * 4 + 2, 1));
                    $keyHigh = ord(substr($this->pdtaChunks['pgen'], $j * 4 + 3, 1));
                } elseif ($gen == 41) {
                    $instId = unpack('v', substr($this->pdtaChunks['pgen'], $j * 4 + 2, 2))[1];
                }
            }

            if ($instId === null || !isset($this->inst_list[$instId])) continue;

            $instName = rtrim(substr($this->inst_list[$instId], 0, 20), "\0");
            $zones[] = [
                'low'      => $keyLow,
                'high'     => $keyHigh,
                'instId'   => $instId,
                'instName' => $instName,
            ];
        }
        return $zones;
    }

    /**
     * Ambil semua sample (shdr entry) dari sebuah instrument.
     */
    private function collectSamplesFromInstrument($instId)
    {
        $samples = [];
        $seen = [];
        $numIbag = (int)(strlen($this->pdtaChunks['ibag']) / 4);

        $ibagStart = unpack('v', substr($this->inst_list[$instId], 20, 2))[1];
        $ibagEnd = isset($this->inst_list[$instId + 1])
            ? unpack('v', substr($this->inst_list[$instId + 1], 20, 2))[1]
            : $numIbag - 1;

        for ($k = $ibagStart; $k < $ibagEnd; $k++) {
            $igenStart = unpack('v', substr($this->pdtaChunks['ibag'], $k * 4, 2))[1];
            $nextOffset = ($k + 1) * 4;
            $igenEnd = ($nextOffset < strlen($this->pdtaChunks['ibag']))
                ? unpack('v', substr($this->pdtaChunks['ibag'], $nextOffset, 2))[1]
                : (int)(strlen($this->pdtaChunks['igen']) / 4);

            for ($l = $igenStart; $l < $igenEnd; $l++) {
                $igenId = unpack('v', substr($this->pdtaChunks['igen'], $l * 4, 2))[1];
                if ($igenId == 53) {
                    $sampleId = unpack('v', substr($this->pdtaChunks['igen'], $l * 4 + 2, 2))[1];
                    if (isset($this->shdr_list[$sampleId]) && !isset($seen[$sampleId])) {
                        $seen[$sampleId] = true;
                        $samples[] = $this->shdr_list[$sampleId];
                    }
                }
            }
        }
        return $samples;
    }

    // ==================================================================
    // TONE: 1 preset -> 1 file, semua sample digabung
    // ==================================================================
    private function writeTonePatch(array $zones, $program, $bank, $presetName, $toneDir)
    {
        // Kumpulkan semua sample dari seluruh zone (dedup)
        $allSamples = [];
        $seen = [];
        foreach ($zones as $zone) {
            foreach ($this->collectSamplesFromInstrument($zone['instId']) as $s) {
                $key = md5($s);
                if (!isset($seen[$key])) {
                    $seen[$key] = true;
                    $allSamples[] = $s;
                }
            }
        }
        if (empty($allSamples)) return;

        list($patContent, $sampleCount) = $this->buildPatFile($allSamples);
        error_log(print_r($sampleCount, true));
        if ($patContent === null) return;

        $formattedMidiNum = sprintf("%03d", $program);
        $cleanName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $presetName);
        $outFileName = "{$formattedMidiNum}_" . strtolower($cleanName) . '.pat';
        $outPath = $toneDir . '/' . $outFileName;

        file_put_contents($outPath, $patContent);

        $this->timidityMap['tone'][$program][] = "tone/{$outFileName}";

        if ($this->db && $this->projectId) {
            $this->db->addPatchToProject(
                $this->projectId,
                "tone/{$outFileName}",
                'tone', $program, $bank, $presetName
            );
        }

        $this->log(sprintf("Bank %3d | [TONE] | Prog %03d: %s (%d samples)",
            $bank, $program, $outFileName, $sampleCount));
        $this->convertedCount++;
    }

    // ==================================================================
    // DRUM: 1 zone (note) -> 1 file
    // ==================================================================
    private function writeDrumPatches(array $zones, $program, $presetName, $drumDir)
    {
        // Dedup per note: zone pertama menang
        $usedNotes = [];

        foreach ($zones as $zone) {
            $note = $zone['low'];  // drum zone biasanya single-note

            if (isset($usedNotes[$note])) continue;

            $samples = $this->collectSamplesFromInstrument($zone['instId']);
            if (empty($samples)) continue;

            list($patContent, $sampleCount) = $this->buildPatFile($samples);
            if ($patContent === null) continue;

            // Nama file pakai instrument name, fallback ke preset name
            $nameForFile = $zone['instName'] !== '' ? $zone['instName'] : $presetName;
            $cleanName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $nameForFile);
            $outFileName = sprintf("%03d_", $note) . strtolower($cleanName) . '.pat';
            $outPath = $drumDir . '/' . $outFileName;

            file_put_contents($outPath, $patContent);

            // Map: drumset[program][note] = path
            $this->timidityMap['drum'][$program][$note] = "drum/{$outFileName}";

            if ($this->db && $this->projectId) {
                $this->db->addPatchToProject(
                    $this->projectId,
                    "drum/{$outFileName}",
                    'drum', $note, 128, $nameForFile
                );
            }

            $this->log(sprintf("Bank 128 | [DRUM] | Note %3d: %s (%d samples)",
                $note, $outFileName, $sampleCount));

            $usedNotes[$note] = true;
            $this->convertedCount++;
        }
    }

    // ==================================================================
    // Build .pat dari list sample shdr
    // ==================================================================
    private function buildPatFile(array $sampleChunks)
    {
        $patBody = '';
        $validSamplesCount = 0;

        foreach ($sampleChunks as $s_chunk) {
            $s_name      = rtrim(substr($s_chunk, 0, 20), "\0");
            $s_start     = unpack('V', substr($s_chunk, 20, 4))[1];
            $s_end       = unpack('V', substr($s_chunk, 24, 4))[1];
            $s_loopStart = unpack('V', substr($s_chunk, 28, 4))[1];
            $s_loopEnd   = unpack('V', substr($s_chunk, 32, 4))[1];
            $s_rate      = unpack('V', substr($s_chunk, 36, 4))[1];
            $s_pitch     = ord(substr($s_chunk, 40, 1));
            $s_pitchCorr = unpack('c', substr($s_chunk, 41, 1))[1];
            $s_type      = unpack('v', substr($s_chunk, 44, 2))[1];

            // Hanya proses sampel mono (tipe 1 atau 4)
            if (($s_type & 0x7FFF) !== 1 && ($s_type & 0x7FFF) !== 4) continue;

            $pcmLenBytes = ($s_end - $s_start) * 2;
            if ($pcmLenBytes <= 0 || $pcmLenBytes > 8 * 1024 * 1024) continue;

            // --- PERBAIKAN 1: Perhitungan Root Frequency & Sample Rate ---
            // Pastikan pitch valid (0-127)
            $pitch = (int)$s_pitch;
            if ($pitch < 0 || $pitch > 127) $pitch = 60; // Fallback ke C4

            // Hitung frekuensi root dalam Hz, termasuk koreksi pitch
            $midiNoteWithCents = $pitch + ($s_pitchCorr / 100.0);
            $rootFreqHz = (int)round(440 * pow(2, ($midiNoteWithCents - 69) / 12));
            if ($rootFreqHz < 8)     $rootFreqHz = 8;
            if ($rootFreqHz > 12544) $rootFreqHz = 12544;

            // Sample rate harus tetap rate asli (tidak dinormalisasi ke C4)
            $sampleRate = (int)$s_rate;
            if ($sampleRate < 8000)  $sampleRate = 8000;
            if ($sampleRate > 48000) $sampleRate = 48000;

            // --- PERBAIKAN 2: Validasi Loop Point yang Ketat ---
            // Loop hanya valid jika berada di dalam batas data PCM
            $pcmSamples = $s_end - $s_start;
            $loopStartS = ($s_loopStart > $s_start) ? ($s_loopStart - $s_start) : 0;
            $loopEndS   = ($s_loopEnd   > $s_start) ? ($s_loopEnd   - $s_start) : 0;
            
            // Pastikan loop end tidak melebihi panjang data
            if ($loopEndS > $pcmSamples) $loopEndS = $pcmSamples;

            // Loop minimal harus memiliki 8 sample untuk menghindari hang
            $hasLoop = ($loopEndS - $loopStartS) >= 8;

            if ($hasLoop) {
                $loopStartByte = $loopStartS * 2;
                $loopEndByte   = $loopEndS * 2;
                $modes = 0x01 | 0x04; // 16-bit + Looping
            } else {
                $loopStartByte = 0;
                $loopEndByte   = 0;
                $modes = 0x01; // 16-bit saja, tanpa loop
            }

            // --- PERBAIKAN 3: Baca PCM dan Tulis Header 96-byte ---
            fseek($this->fp, $this->smplOffset + ($s_start * 2));
            $rawPcm = fread($this->fp, $pcmLenBytes);
            if (strlen($rawPcm) != $pcmLenBytes) continue;

            // Konversi ke signed 16-bit little-endian
            $currentPcm = '';
            for ($j = 0; $j < $pcmLenBytes / 2; $j++) {
                $currentPcm .= pack('v', unpack('s', substr($rawPcm, $j * 2, 2))[1]);
            }

            // Susun Wave Header (96 bytes) sesuai spesifikasi
            $waveHeader  = str_pad(substr($s_name, 0, 7), 7, "\0"); // 0: name
            $waveHeader .= pack('C', 0);                            // 7: fractions
            $waveHeader .= pack('V', $pcmLenBytes);                 // 8: length
            $waveHeader .= pack('V', $loopStartByte);               // 12: loop start
            $waveHeader .= pack('V', $loopEndByte);                 // 16: loop end
            $waveHeader .= pack('v', $sampleRate);                  // 20: sample rate
            $waveHeader .= pack('V', 8);                            // 22: low freq (8 Hz)
            $waveHeader .= pack('V', 12544);                        // 26: high freq (12544 Hz)
            $waveHeader .= pack('V', $rootFreqHz);                  // 30: root freq
            $waveHeader .= pack('v', 0);                            // 34: finetune
            $waveHeader .= pack('C', 8);                            // 36: panning (center)
            $waveHeader .= pack('CCCCCC', 63, 63, 63, 63, 63, 63);  // 37-42: env rates
            $waveHeader .= pack('CCCCCC', 0,  0,  0,  0,  0,  0);   // 43-48: env offsets
            $waveHeader .= str_repeat("\0", 6);                     // 49-54: tremolo/vibrato
            $waveHeader .= pack('C', $modes);                       // 55: modes
            $waveHeader .= str_repeat("\0", 40);                    // 56-95: reserved

            $patBody .= $waveHeader . $currentPcm;
            $validSamplesCount++;
        }

        if ($validSamplesCount === 0) return [null, 0];

        // Susun Patch Header (239 bytes)
        $header  = "GF1PATCH110\0";                              // 0-11
        $header .= str_pad("ID#000002\0", 10, "\0");             // 12-21
        $header .= str_pad("PHP SF2->PAT", 60, "\0");            // 22-81
        $header .= str_repeat("\0", 116);                        // 82-197
        $header .= pack('C', $validSamplesCount);                // 198: sample count
        $header .= str_repeat("\0", 40);                         // 199-238

        return [$header . $patBody, $validSamplesCount];
    }

    // ==================================================================
    // WRITE timidity.cfg
    // ==================================================================
    private function writeTimidityConfig()
    {
        $cfg  = "# Auto-generated mapping\n";
        $cfg .= "dir .\n\n";

        // ---------- DRUMSETS ----------
        if (!empty($this->timidityMap['drum'])) {
            $drumsets = $this->timidityMap['drum'];
            ksort($drumsets);
            foreach ($drumsets as $progNum => $notes) {
                $cfg .= "drumset {$progNum}\n";
                ksort($notes);
                foreach ($notes as $note => $path) {
                    $cfg .= sprintf("%-3d %s\n", $note, $path);
                }
                $cfg .= "\n";
            }
        }

        // ---------- BANK 0 (MELODIC) ----------
        $cfg .= "bank 0\n\n";
        if (!empty($this->timidityMap['tone'])) {
            $tones = $this->timidityMap['tone'];
            ksort($tones);
            foreach ($tones as $progNum => $paths) {
                foreach ($paths as $path) {
                    $cfg .= sprintf("%3d %s\n", $progNum, $path);
                }
            }
        }

        file_put_contents($this->outputDir . '/timidity.cfg', $cfg);
    }
}
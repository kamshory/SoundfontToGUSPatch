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
     * 
     * @param int $projectId
     */
    public function setProjectId($projectId) 
    { 
        $this->projectId = $projectId; 
    }

    /**
     * Sets the database manager instance.
     * 
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
     * @param string $sourceFilePath SF2 path file
     * @param string $outputDirectory Output directory path
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

    /**
     * Read all RIFF chunks and populate internal arrays.
     * 
     * @throws Exception
     * @return void
     */
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
                $listContentStart = ftell($this->fp);
                $listContentEnd   = $listContentStart + ($size - 4);

                if ($type === 'sdta') {
                    // Streaming: don't read LIST sdta content, just find smpl chunk
                    $cursor = $listContentStart;
                    while ($cursor + 8 <= $listContentEnd) {
                        fseek($this->fp, $cursor, SEEK_SET);
                        $subHeader = fread($this->fp, 8);
                        if (strlen($subHeader) < 8) break;

                        $subId   = substr($subHeader, 0, 4);
                        $subSize = unpack('V', substr($subHeader, 4, 4))[1];

                        if ($subId === 'smpl') {
                            $this->smplOffset = $cursor + 8;
                            break;
                        }
                        $cursor += 8 + $subSize;
                        if ($subSize % 2 !== 0) $cursor++;
                    }
                    // Jump to end of LIST
                    fseek($this->fp, $listContentEnd, SEEK_SET);

                } elseif ($type === 'pdta') {
                    // pdta small (< 1 MB), safe to read
                    $listContent = fread($this->fp, $size - 4);
                    $offset = 0;
                    while ($offset < strlen($listContent)) {
                        $subId   = substr($listContent, $offset, 4);
                        $subSize = unpack('V', substr($listContent, $offset + 4, 4))[1];
                        $this->pdtaChunks[$subId] = substr($listContent, $offset + 8, $subSize);
                        $offset += 8 + $subSize;
                        if ($subSize % 2 !== 0) $offset++;
                    }

                } else {
                    // Other LIST - skip
                    fseek($this->fp, $listContentEnd, SEEK_SET);
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

    /**
     * Parse pdta subchunks from RIFF
     * 
     * @throws Exception
     * @return void
     */
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
     * Parse SF2 struct array from binary data
     * 
     * @param string $data Data
     * @param int $struct_size Struct size
     * @return array Struct array
     */
    private function parseStructArray($data, $struct_size)
    {
        $items = [];
        for ($i = 0; $i <= strlen($data) - $struct_size; $i += $struct_size) {
            $items[] = substr($data, $i, $struct_size);
        }
        return $items;
    }
    
    /**
     * Process presets and generate patches
     * 
     * @throws Exception
     * @return void
     */
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
     * 
     * @param mixed $pbagStart Pbag start offset
     * @param mixed $pbagEnd Pbag end offset
     * @return array Zones
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
     * Get all samples (shdr entry) from an instrument
     * 
     * @param int $instId Instrument ID
     * @return array Samples
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

            $coarseTune        = 0;
            $fineTune          = 0;
            $scaleTuning       = 100;  // default SF2: 100 cents per semitone
            $overridingRootKey = null;
            $sampleId          = null;

            for ($l = $igenStart; $l < $igenEnd; $l++) {
                $igenId = unpack('v', substr($this->pdtaChunks['igen'], $l * 4, 2))[1];
                $amount = unpack('s', substr($this->pdtaChunks['igen'], $l * 4 + 2, 2))[1];

                if ($igenId == 51) {        // coarseTune (semitones)
                    $coarseTune = $amount;
                } elseif ($igenId == 52) {  // fineTune (cents)
                    $fineTune = $amount;
                } elseif ($igenId == 53) {  // sampleID
                    $sampleId = $amount;
                } elseif ($igenId == 56) {  // scaleTuning (cents per key, default 100)
                    // Nilai di igen adalah unsigned 16-bit, tapi semantiknya 0–1200
                    $scaleTuning = unpack('v', substr($this->pdtaChunks['igen'], $l * 4 + 2, 2))[1];
                } elseif ($igenId == 58) {  // overridingRootKey
                    // Hanya berlaku jika nilai 0–127
                    $ork = unpack('v', substr($this->pdtaChunks['igen'], $l * 4 + 2, 2))[1];
                    if ($ork >= 0 && $ork <= 127) {
                        $overridingRootKey = $ork;
                    }
                }
            }

            if ($sampleId !== null && isset($this->shdr_list[$sampleId]) && !isset($seen[$sampleId])) {
                $seen[$sampleId] = true;
                $samples[] = [
                    'data'              => $this->shdr_list[$sampleId],
                    'coarseTune'        => $coarseTune,
                    'fineTune'          => $fineTune,
                    'scaleTuning'       => $scaleTuning,
                    'overridingRootKey' => $overridingRootKey,
                ];
            }
        }
        return $samples;
    }

    /**
     * Write tone patch for Creative Sound Blaster AWE32/32/64
     * 
     * @param $zones Zones    
     * @param mixed $program Program
     * @param mixed $bank Bank
     * @param mixed $presetName Preset name
     * @param mixed $toneDir Tone directory
     * @return void
     */
    private function writeTonePatch($zones, $program, $bank, $presetName, $toneDir)
    {
        $allSamples = [];
        $seen = [];
        foreach ($zones as $zone) {
            foreach ($this->collectSamplesFromInstrument($zone['instId']) as $s) {
                $key = md5($s['data']);
                if (!isset($seen[$key])) {
                    $seen[$key] = true;
                    $allSamples[] = $s;
                }
            }
        }
        if (empty($allSamples)) return;

        $formattedMidiNum = sprintf("%03d", $program);
        $cleanName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $presetName);
        $outFileName = "{$formattedMidiNum}_" . strtolower($cleanName) . '.pat';
        $outPath = $toneDir . '/' . $outFileName;

        $sampleCount = $this->buildPatFileStreaming($allSamples, $outPath);
        if ($sampleCount === 0) {
            @unlink($outPath);
            return;
        }

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

    /**
     * Build pat file for Creative Sound Blaster AWE32/32/64 by streaming
     * 
     * @param $sampleChunks SF2 samples (shdr entry) and tuneCents
     * @param mixed $outPath Output path to write PAT file
     * @throws Exception
     * @return int The number of valid samples written
     */
    private function buildPatFileStreaming($sampleChunks, $outPath)
    {
        $out = fopen($outPath, 'wb');
        if (!$out) {
            throw new \Exception("Cannot open output file: {$outPath}");
        }

        // Write pat file header (239 bytes) for Creative Sound Blaster AWE32/32/64
        $header  = "GF1PATCH110\0";
        $header .= str_pad("ID#000002\0", 10, "\0");
        $header .= str_pad("PHP SF2->PAT", 60, "\0");
        $header .= str_repeat("\0", 116);
        $header .= pack('C', 0);        // placeholder sample count at offset 198
        $header .= str_repeat("\0", 40);
        fwrite($out, $header);

        $validSamplesCount = 0;
        $blockSize = 1024 * 1024;       // read PCM per 1 MB

        foreach ($sampleChunks as $s_chunk) {
            // ---- Parsing shdr ----
            if (is_array($s_chunk)) {
                $sampleData = $s_chunk['data'];
            } else {
                $sampleData = $s_chunk;
            }
            if (strlen($sampleData) < 46) continue;

            $s_name      = rtrim(substr($sampleData, 0, 20), "\0");
            $s_start     = unpack('V', substr($sampleData, 20, 4))[1];
            $s_end       = unpack('V', substr($sampleData, 24, 4))[1];
            $s_loopStart = unpack('V', substr($sampleData, 28, 4))[1];
            $s_loopEnd   = unpack('V', substr($sampleData, 32, 4))[1];
            $s_rate      = unpack('V', substr($sampleData, 36, 4))[1];
            $s_type      = unpack('v', substr($sampleData, 44, 2))[1];

            if (($s_type & 0x7FFF) !== 1) continue;

            $pcmSamples = $s_end - $s_start;
            if ($pcmSamples <= 0 || $pcmSamples > 200 * 1024 * 1024) continue; // naikkan batas ke 200 M sample
            $pcmLenBytes = $pcmSamples * 2;

            // ---- Tuning ----
            $coarseTune        = is_array($s_chunk) && isset($s_chunk['coarseTune'])        ? (int)$s_chunk['coarseTune']        : 0;
            $fineTune          = is_array($s_chunk) && isset($s_chunk['fineTune'])          ? (int)$s_chunk['fineTune']          : 0;
            $scaleTuning       = is_array($s_chunk) && isset($s_chunk['scaleTuning'])       ? (int)$s_chunk['scaleTuning']       : 100;
            $overridingRootKey = is_array($s_chunk) && isset($s_chunk['overridingRootKey']) ? $s_chunk['overridingRootKey']      : null;

            $rootFreqHz = $this->calculateEffectiveRootFreq(
                $sampleData,
                $coarseTune,
                $fineTune,
                $scaleTuning,
                $overridingRootKey
            );

            // ---- Sample rate ----
            $sampleRate = (int)$s_rate;

            // ---- Loop ----
            $loopStartS = ($s_loopStart > $s_start) ? ($s_loopStart - $s_start) : 0;
            $loopEndS   = ($s_loopEnd   > $s_start) ? ($s_loopEnd   - $s_start) : 0;
            if ($loopEndS > $pcmSamples) $loopEndS = $pcmSamples;

            $hasLoop = ($loopEndS - $loopStartS) >= 8;

            if ($hasLoop) {
                $loopStartByte = $loopStartS * 2;
                $loopEndByte   = $loopEndS * 2;
                $modes = 0x01 | 0x04;
            } else {
                $loopStartByte = 0;
                $loopEndByte   = 0;
                $modes = 0x01;
            }

            // ---- Build wave header 96 byte in memory (small) ----
            $waveHeader  = str_pad(substr($s_name, 0, 7), 7, "\0");
            $waveHeader .= pack('C', 0);
            $waveHeader .= pack('V', $pcmLenBytes);
            $waveHeader .= pack('V', $loopStartByte);
            $waveHeader .= pack('V', $loopEndByte);
            $waveHeader .= pack('v', $sampleRate);
            $waveHeader .= pack('V', 8);
            $waveHeader .= pack('V', 12544);
            $waveHeader .= pack('V', (int)round($rootFreqHz * 1024));  // fixed-point 10.22 (according to convention)
            $waveHeader .= pack('v', 0);
            $waveHeader .= pack('C', 8);
            $waveHeader .= pack('CCCCCC', 63, 63, 63, 63, 63, 63);
            $waveHeader .= pack('CCCCCC', 0, 0, 0, 0, 0, 0);    // loop envelope (unused in GUS)
            $waveHeader .= str_repeat("\0", 6);
            $waveHeader .= pack('C', $modes);
            $waveHeader .= str_repeat("\0", 40);

            if (strlen($waveHeader) !== 96) continue;

            fwrite($out, $waveHeader);

            // ---- Streaming PCM per block ----
            $seekPos = $this->smplOffset + ($s_start * 2);
            if (fseek($this->fp, $seekPos, SEEK_SET) !== 0) continue;

            $remaining = $pcmLenBytes;
            $pcmOk = true;
            while ($remaining > 0) {
                $read = ($remaining > $blockSize) ? $blockSize : $remaining;
                $buf = fread($this->fp, $read);
                if ($buf === false || strlen($buf) === 0) {
                    $pcmOk = false;
                    break;
                }
                fwrite($out, $buf);
                $remaining -= strlen($buf);
            }

            if (!$pcmOk) {
                // Read PCM failed in the middle - can't rollback file
                // so stop and let the caller know through a smaller sample count.
                break;
            }

            $validSamplesCount++;
        }

        // ---- Rewrite sample count di offset 198 ----
        if ($validSamplesCount > 255) $validSamplesCount = 255;
        if (fseek($out, 198, SEEK_SET) === 0) {
            fwrite($out, pack('C', $validSamplesCount));
        }
        fclose($out);

        return $validSamplesCount;
    }

    /**
     * Write drum patch
     * 
     * @param $zones Zones
     * @param mixed $program Program
     * @param mixed $presetName Preset name
     * @param mixed $drumDir Drum directory
     * @return void
     */
    private function writeDrumPatches($zones, $program, $presetName, $drumDir)
    {
        $usedNotes = [];

        foreach ($zones as $zone) {
            $note = $zone['low'];
            if (isset($usedNotes[$note])) continue;

            $samples = $this->collectSamplesFromInstrument($zone['instId']);
            if (empty($samples)) continue;

            $nameForFile = $zone['instName'] !== '' ? $zone['instName'] : $presetName;
            $cleanName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $nameForFile);
            $outFileName = sprintf("%03d_", $note) . strtolower($cleanName) . '.pat';
            $outPath = $drumDir . '/' . $outFileName;

            $sampleCount = $this->buildPatFileStreaming($samples, $outPath);
            if ($sampleCount === 0) {
                @unlink($outPath);
                continue;
            }

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

    /**
     * Calculate effective root frequency
     * 
     * @param string $sampleData Sample data (46 bytes)
     * @param int $coarseTune Coarse tuning (semitones)
     * @param int $fineTune Fine tuning (cents)
     * @param int $scaleTuning Scale tuning (cents per key)
     * @param int|null $overridingRootKey Overriding root key
     * @return float|int Effective root frequency
     */
    private function calculateEffectiveRootFreq(
        $sampleData,
        $coarseTune = 0,
        $fineTune = 0,
        $scaleTuning = 100,
        $overridingRootKey = null
    ) {
        // Root key: overridingRootKey (kalau ada) atau byOriginalPitch
        if ($overridingRootKey !== null) {
            $rootKey = (int)$overridingRootKey;
        } else {
            $rootKey = ord(substr($sampleData, 40, 1));
        }
        if ($rootKey < 0)   $rootKey = 0;
        if ($rootKey > 127) $rootKey = 60;

        // chPitchCorrection in cents (signed)
        $pitchCorr = unpack('c', substr($sampleData, 41, 1))[1];

        // root_freq = natural frequency of sample when played at rootKey
        // This includes:
        //   - pitchCorr  : fine correction from shdr (cents)
        //   - coarseTune : semitone offset from igen/pgen
        //   - fineTune   : cents offset from igen/pgen
        //
        // scaleTuning is NOT included here. scaleTuning (igen 56) sets how
        // the player stretches pitch per key (default 100 cents/semitone).
        // Standard .pat players (TiMidity++) already assume 100 cents/semitone,
        // so including scaleTuning in root_freq would cause transposition.
        
        $midiNote = $rootKey
                  + ($pitchCorr / 100.0)
                  + $coarseTune
                  + ($fineTune / 100.0);

        // Correcting by 100 cents per semitone
        $freqHz = 440.0 * pow(2.0, ($midiNote - 69.0) / 12.0);

        // Clamp to safe range
        if ($freqHz < 8.0)     $freqHz = 8.0;
        if ($freqHz > 12544.0) $freqHz = 12544.0;

        return $freqHz;
    }

    /**
     * Write timidity config `timidity.cfg`
     * 
     * @return void
     */
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
                    $cfg .= sprintf("%-3d %s\n", $progNum, $path);
                }
            }
        }

        file_put_contents($this->outputDir . '/timidity.cfg', $cfg);
    }
}
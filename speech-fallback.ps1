$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -like 'zh-*' } | Select-Object -First 1
if (!$info) { throw 'Chinese speech recognition is unavailable' }
$engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($info)
$audio = New-Object IO.MemoryStream(,[Convert]::FromBase64String([Console]::In.ReadToEnd()))
try {
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveStream($audio)
  while ($null -ne ($result = $engine.Recognize())) { [Console]::WriteLine($result.Text) }
} finally { $engine.Dispose(); $audio.Dispose() }

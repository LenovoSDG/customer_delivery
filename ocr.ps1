param([string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
function AwaitResult($op,$type){$t=$method.MakeGenericMethod($type).Invoke($null,@($op));$t.GetAwaiter().GetResult()}
$f=AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=AwaitResult ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime])
try{
$d=AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$b=AwaitResult ($d.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$lang=[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object LanguageTag -like 'zh*' | Select-Object -First 1
if(!$lang){throw '请先在 Windows 语言设置中安装中文 OCR 语言组件'}
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
$r=AwaitResult ($engine.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime])
$lines=@(foreach($l in $r.Lines){$box=$l.Words[0].BoundingRect;@{text=$l.Text;x=@($box.X)[0];y=@($box.Y)[0]}})
@{width=$b.PixelWidth;height=$b.PixelHeight;lines=$lines}|ConvertTo-Json -Depth 4 -Compress
}finally{if($b){$b.Dispose()};$stream.Dispose()}


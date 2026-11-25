using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
class Desk {
 [STAThread] static void Main(){try{
 var dir=AppDomain.CurrentDomain.BaseDirectory;
 var url="http://127.0.0.1:4190/";
 Func<bool> ready=delegate{try{using(var c=new WebClient())return c.DownloadString(url+"api/health").Contains("ollama");}catch{return false;}};
 if(!ready()){
 var p=new ProcessStartInfo(Path.Combine(dir,"node.exe"),"server.js");p.WorkingDirectory=dir;p.UseShellExecute=false;p.CreateNoWindow=true;
 p.EnvironmentVariables["HOST"]="127.0.0.1";p.EnvironmentVariables["PORT"]="4190";p.EnvironmentVariables["DATABASE_URL"]="";p.EnvironmentVariables["APP_DATA_DIR"]=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ZhiHuiData");p.EnvironmentVariables["OLLAMA_URL"]="http://127.0.0.1:11434";
 Process.Start(p);for(int n=0;n<50&&!ready();n++)Thread.Sleep(200);if(!ready())throw new Exception("无法启动工作台，请检查端口 4190。");
 }
 string edge=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),@"Microsoft\Edge\Application\msedge.exe");
 if(File.Exists(edge))Process.Start(edge,"--app="+url);else Process.Start(url);
 using(var c=new WebClient()){try{if(c.DownloadString(url+"api/model-settings").Contains("\"mode\":\"api\""))return;}catch{}}
 using(var c=new WebClient()){try{if(c.DownloadString("http://127.0.0.1:11434/api/tags").Contains("qwen3:4b"))return;}catch{}}
 Process.Start(new ProcessStartInfo(Path.Combine(dir,"ModelSetup.cmd")){WorkingDirectory=dir});
 }catch(Exception e){MessageBox.Show(e.Message,"智汇");}}
}


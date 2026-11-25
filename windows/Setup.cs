using System;
using System.IO;
using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
class Setup {
 [STAThread] static void Main(){if(MessageBox.Show("将智汇安装到当前用户目录，创建开始菜单入口并打开工作台？","安装智汇",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
 try{var dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ZhiHuiApp","build-"+Guid.NewGuid().ToString("N").Substring(0,8));Directory.CreateDirectory(dir);
 using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload"))using(var zip=new ZipArchive(stream)){foreach(var item in zip.Entries){var p=Path.GetFullPath(Path.Combine(dir,item.FullName));if(!p.StartsWith(dir+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("安装包路径异常");if(item.Name==""){Directory.CreateDirectory(p);continue;}Directory.CreateDirectory(Path.GetDirectoryName(p));item.ExtractToFile(p);}}
 var exe=Path.Combine(dir,"ZhiHui.exe");var shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));dynamic w=shell;dynamic link=w.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"智汇.lnk"));link.TargetPath=exe;link.WorkingDirectory=dir;link.Save();Process.Start(exe);
 }catch(Exception e){MessageBox.Show(e.Message,"智汇安装失败");}}
}

import { promises as fs } from 'fs';
import { spawn } from 'child_process';

export async function getFileNames(dirPath: string): Promise<string[]> {
  try {
    const filesAndFolders: string[] = await fs.readdir(dirPath);
    return filesAndFolders;
  } catch (error) {
    console.error('Error reading directory:', error);
    return [];
  }
}

// export async function runScriptFile(scriptPath:string, args: Record<string,string>): Promise<void>{
//   return new Promise((resolve, reject) => {
    
//     const child = spawn(scriptPath, args);

//     child.stdout.on('data', (data) => {
//       process.stdout.write(`[Script Output]: ${data}`);
//     });
    
//     child.stderr.on('data', (data) => {
//       process.stderr.write(`[Script Error]: ${data}`);
//     });
    
//     child.on('close', (code) => {
//       if (code === 0) {
//         resolve();
//       } else {
//         reject(new Error(`Script exited with error code ${code}`));
//       }
//     });

//     child.on('error', (err) => {
//       reject(err);
//     });
//   });
// }
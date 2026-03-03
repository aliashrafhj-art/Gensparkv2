import yt_dlp
import os
import uuid
from config import Config

class VideoDownloader:
    def download(self, url, progress_hook=None):
        filename = f"{uuid.uuid4().hex}.mp4"
        output_path = os.path.join(Config.TEMP_DIR, filename)
        
        ydl_opts = {
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            'outtmpl': output_path,
            'quiet': True,
            'no_warnings': True,
        }
        
        if progress_hook:
            ydl_opts['progress_hooks'] = [progress_hook]

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            
        return output_path

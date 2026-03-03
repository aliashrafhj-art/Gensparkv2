import requests
import os
import uuid
from config import Config

class SubtitleDownloader:
    def download(self, url):
        response = requests.get(url)
        ext = url.split('.')[-1].split('?')[0]
        if len(ext) > 4: ext = 'srt' # fallback
        
        filename = f"{uuid.uuid4().hex}.{ext}"
        path = os.path.join(Config.TEMP_DIR, filename)
        
        with open(path, 'wb') as f:
            f.write(response.content)
            
        return path

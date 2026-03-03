import os
import json
import time
import queue
import threading
import logging
from flask import Flask, render_template, request, Response, stream_with_context, jsonify
from dotenv import load_dotenv

# Import modules
from config import Config
from extractor.link_extractor import LinkExtractor
from downloader.video_downloader import VideoDownloader
from downloader.subtitle_downloader import SubtitleDownloader
from processor.subtitle_processor import SubtitleProcessor
from processor.video_processor import VideoProcessor
from uploader.telegram_uploader import TelegramUploader

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config.from_object(Config)

# Progress queues for SSE
progress_queues = {}

def send_progress(task_id, message, percent=None, status="processing", done=False, error=None, data=None):
    """Helper to put progress into queue"""
    if task_id in progress_queues:
        msg = {
            "message": message,
            "percent": percent,
            "status": status,
            "done": done,
            "error": error,
            "data": data
        }
        progress_queues[task_id].put(msg)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/extract', methods=['POST'])
def extract_links():
    data = request.json
    url = data.get('url')
    task_id = data.get('task_id')
    
    if not url or not task_id:
        return jsonify({"error": "Missing URL or task_id"}), 400
        
    # Initialize queue
    progress_queues[task_id] = queue.Queue()
    
    # Run in thread
    def extraction_worker():
        try:
            send_progress(task_id, "Initializing browser...", 10)
            extractor = LinkExtractor()
            
            send_progress(task_id, "Navigating to page...", 30)
            links = extractor.extract(url)
            
            send_progress(task_id, "Extraction complete!", 100, done=True, data=links)
        except Exception as e:
            logger.error(f"Extraction failed: {e}")
            send_progress(task_id, f"Error: {str(e)}", status="error", error=str(e), done=True)

    threading.Thread(target=extraction_worker).start()
    return jsonify({"status": "started", "task_id": task_id})

@app.route('/api/process', methods=['POST'])
def process_video():
    data = request.json
    task_id = data.get('task_id')
    video_url = data.get('video_url')
    sub_url = data.get('sub_url') # Optional
    
    if not video_url or not task_id:
        return jsonify({"error": "Missing data"}), 400

    progress_queues[task_id] = queue.Queue()

    def process_worker():
        try:
            # 1. Download Video
            send_progress(task_id, "Downloading video...", 0)
            downloader = VideoDownloader()
            
            def dl_hook(d):
                if d['status'] == 'downloading':
                    p = d.get('_percent_str', '0%').replace('%','')
                    try:
                        send_progress(task_id, f"Downloading: {d.get('_percent_str')}", float(p))
                    except: pass

            video_path = downloader.download(video_url, progress_hook=dl_hook)
            send_progress(task_id, "Video downloaded successfully", 30)

            # 2. Process Subtitle (if any)
            final_sub_path = None
            if sub_url:
                send_progress(task_id, "Downloading subtitle...", 35)
                sub_downloader = SubtitleDownloader()
                raw_sub_path = sub_downloader.download(sub_url)
                
                send_progress(task_id, "Processing Bengali subtitle...", 40)
                sub_processor = SubtitleProcessor()
                final_sub_path = sub_processor.convert_to_ass(raw_sub_path)
            
            # 3. Hardcode Subtitle (Burn)
            final_video_path = video_path
            if final_sub_path:
                send_progress(task_id, "Burning subtitles (this takes time)...", 50)
                processor = VideoProcessor()
                final_video_path = processor.hardcode_subtitle(video_path, final_sub_path)
            
            send_progress(task_id, "Video processing complete!", 70)

            # 4. Upload to Telegram
            send_progress(task_id, "Uploading to Telegram...", 75)
            uploader = TelegramUploader(
                api_id=Config.API_ID,
                api_hash=Config.API_HASH,
                bot_token=Config.BOT_TOKEN
            )
            
            def upload_progress(current, total):
                percent = (current / total) * 100
                send_progress(task_id, f"Uploading: {percent:.1f}%", 75 + (percent/4))

            uploader.upload_video(
                chat_id=Config.CHANNEL_ID,
                video_path=final_video_path,
                caption=f"Downloaded via AnimeDL\nSource: {video_url}",
                progress_callback=upload_progress
            )
            
            send_progress(task_id, "All tasks completed successfully!", 100, done=True)
            
            # Cleanup
            # os.remove(video_path)
            # if final_sub_path: os.remove(final_sub_path)
            
        except Exception as e:
            logger.error(f"Process failed: {e}")
            send_progress(task_id, f"Error: {str(e)}", status="error", error=str(e), done=True)

    threading.Thread(target=process_worker).start()
    return jsonify({"status": "started"})

@app.route('/progress/')
def progress(task_id):
    def generate():
        q = progress_queues.get(task_id)
        if not q:
            return
        
        while True:
            try:
                # Wait for message with timeout to keep connection alive
                msg = q.get(timeout=20)
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get('done'):
                    break
            except queue.Empty:
                yield f"data: {json.dumps({'keepalive': True})}\n\n"
            except Exception as e:
                break
                
    return Response(stream_with_context(generate()), 
                   mimetype='text/event-stream',
                   headers={
                       'Cache-Control': 'no-cache',
                       'X-Accel-Buffering': 'no' # Critical for Railway
                   })

if __name__ == '__main__':
    # Ensure directories exist
    os.makedirs(Config.TEMP_DIR, exist_ok=True)
    os.makedirs(Config.FONTS_DIR, exist_ok=True)
    
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)

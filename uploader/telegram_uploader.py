from pyrogram import Client
import os

class TelegramUploader:
    def __init__(self, api_id, api_hash, bot_token):
        self.app = Client(
            "bot_session",
            api_id=api_id,
            api_hash=api_hash,
            bot_token=bot_token,
            in_memory=True
        )

    def upload_video(self, chat_id, video_path, caption, progress_callback=None):
        with self.app:
            self.app.send_video(
                chat_id=chat_id,
                video=video_path,
                caption=caption,
                supports_streaming=True,
                progress=progress_callback
            )

import ffmpeg
import os
import uuid
from config import Config

class VideoProcessor:
    def hardcode_subtitle(self, video_path, sub_path):
        """
        Hardcodes subtitle into video using FFmpeg with proper font dir
        """
        output_filename = f"burned_{uuid.uuid4().hex}.mp4"
        output_path = os.path.join(Config.TEMP_DIR, output_filename)
        
        # FFmpeg command structure
        # We use the subtitles filter with fontsdir to point to NotoSansBengali
        
        # Convert absolute paths to unix style for ffmpeg filter
        sub_path_unix = sub_path.replace('\\', '/').replace(':', '\\:')
        fonts_dir_unix = Config.FONTS_DIR.replace('\\', '/').replace(':', '\\:')
        
        # Styling for Netflix look
        style = "Fontname=Noto Sans Bengali,Fontsize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=1,Outline=1.5,Shadow=0,MarginV=25"

        try:
            (
                ffmpeg
                .input(video_path)
                .output(
                    output_path,
                    vf=f"subtitles='{sub_path_unix}':fontsdir='{fonts_dir_unix}':force_style='{style}'",
                    vcodec='libx264',
                    preset='fast',
                    crf=23,
                    acodec='copy'
                )
                .global_args('-report') # For debugging
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            return output_path
        except ffmpeg.Error as e:
            print('FFmpeg Error:', e.stderr.decode('utf8'))
            raise e

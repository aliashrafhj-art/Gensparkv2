import os

class Config:
    # Flask settings
    SECRET_KEY = os.environ.get('SECRET_KEY', 'default-secret-key')
    
    # Telegram settings
    API_ID = int(os.environ.get('API_ID', '0'))
    API_HASH = os.environ.get('API_HASH', '')
    BOT_TOKEN = os.environ.get('BOT_TOKEN', '')
    CHANNEL_ID = int(os.environ.get('CHANNEL_ID', '0'))
    
    # Directories
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    TEMP_DIR = os.path.join(BASE_DIR, 'temp')
    FONTS_DIR = os.path.join(BASE_DIR, 'fonts')
    
    # Font path
    BENGALI_FONT_PATH = os.path.join(FONTS_DIR, 'NotoSansBengali-Regular.ttf')

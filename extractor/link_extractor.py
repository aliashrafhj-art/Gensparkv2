from playwright.sync_api import sync_playwright
import re
import time

class LinkExtractor:
    def __init__(self):
        self.found_links = {
            "m3u8": [],
            "mp4": [],
            "subtitles": []
        }

    def extract(self, url):
        with sync_playwright() as p:
            # Launch browser
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            )
            page = context.new_page()

            # Network interceptor
            def handle_request(request):
                url = request.url
                # Filter useful links
                if ".m3u8" in url and "master" in url:
                    if url not in self.found_links["m3u8"]:
                        self.found_links["m3u8"].append(url)
                elif ".mp4" in url:
                    if url not in self.found_links["mp4"]:
                        self.found_links["mp4"].append(url)
                elif re.search(r'\.(vtt|srt|ass)', url):
                    if url not in self.found_links["subtitles"]:
                        self.found_links["subtitles"].append(url)

            page.on("request", handle_request)

            try:
                page.goto(url, timeout=60000)
                page.wait_for_load_state("networkidle")
                
                # Check iframes
                for frame in page.frames:
                    try:
                        frame_url = frame.url
                        if "embed" in frame_url or "player" in frame_url:
                            # Sometimes video links are in iframe src
                            pass
                    except: pass
                    
                time.sleep(5) # Wait for extra JS loads
                
            except Exception as e:
                print(f"Error loading page: {e}")
            finally:
                browser.close()

        return self.found_links

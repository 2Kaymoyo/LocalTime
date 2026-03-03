import threading
import webview
import os
import sys
import tracker  # This imports your existing tracker.py engine!

def get_html_path():
    # When packaged into an app, Mac hides files in a temporary folder. 
    # This ensures it can always find your dashboard.html design.
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'dashboard.html')
    return os.path.join(os.path.abspath(os.path.dirname(__file__)), 'dashboard.html')

def start_background_services():
    # Start the database and background tracking tools
    tracker.init_db()
    threading.Thread(target=tracker.run_server, daemon=True).start()
    threading.Thread(target=tracker.desktop_tracker_loop, daemon=True).start()

if __name__ == '__main__':
    print("Starting LocalTime...")
    
    # 1. Turn on the background engine
    start_background_services()

    # 2. Find the dashboard design
    html_file = get_html_path()

    # 3. Create the Mac window
    window = webview.create_window(
        title='LocalTime',
        url=f'file://{html_file}',
        width=1100,
        height=750
    )

    # 4. Launch!
    webview.start()
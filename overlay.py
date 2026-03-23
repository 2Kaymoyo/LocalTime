import logging
import tkinter as tk
import urllib.request, json
from datetime import datetime, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

try: from pynput import keyboard
except ImportError: print("Run 'pip3 install pynput'"); exit()

class DashboardOverlay:
    def __init__(self, root):
        self.root = root
        self.root.title("LocalTime Dashboard")
        self.root.attributes('-topmost', True); self.root.geometry("900x800")
        self.is_visible = True
        self.bg_color = "#0F0F13"; self.nav_bg = "#1A1A22"; self.accent_main = "#5865F2"
        self.accent_good = "#43B581"; self.accent_bad = "#F04747"; self.text_main = "#F2F3F5"; self.text_dim = "#949BA4"
        self.chart_colors = ["#7289DA", "#43B581", "#FAA61A", "#F04747", "#B9BBBE"]
        self.root.configure(bg=self.bg_color)
        
        keyboard.GlobalHotKeys({'<shift>+<ctrl>+t': self.trigger_toggle}).start()
        
        self.nav_frame = tk.Frame(self.root, bg=self.nav_bg, height=60); self.nav_frame.pack(fill="x"); self.nav_frame.pack_propagate(False)
        self.page = 1; self.nav_labels = []
        for text, p_num in [("Pulse", 1), ("Trends", 2), ("Timeline", 3)]:
            lbl = tk.Label(self.nav_frame, text=text, font=("Inter", 15, "bold"), bg=self.nav_bg, fg=self.text_dim, padx=30, cursor="hand2")
            lbl.pack(side="left", fill="y"); lbl.bind("<Button-1>", lambda e, n=p_num: self.switch_page(n))
            self.nav_labels.append((lbl, p_num))
        
        self.content_frame = tk.Frame(self.root, bg=self.bg_color); self.content_frame.pack(fill="both", expand=True, padx=50, pady=30)
        self.session_active = False
        self.switch_page(1); self.update_data()

    def trigger_toggle(self): self.root.after(0, self._toggle_visibility)
    def _toggle_visibility(self):
        if self.is_visible: self.root.withdraw(); self.is_visible = False
        else: self.root.deiconify(); self.root.lift(); self.root.attributes('-topmost', True); self.is_visible = True

    def switch_page(self, n):
        self.page = n
        for lbl, p_num in self.nav_labels: lbl.config(fg=self.accent_main if p_num == n else self.text_dim)
        for w in self.content_frame.winfo_children(): w.destroy()
        if n == 1: self.build_page_1()
        elif n == 2: self.build_page_2()
        elif n == 3: self.build_page_3()

    def toggle_session(self):
        p = "/session/stop" if self.session_active else "/session/start"
        try: urllib.request.urlopen(f'http://127.0.0.1:5050{p}', data=b"")
        except Exception as e: logger.warning("Failed to toggle session: %s", e)

    def build_page_1(self):
        header = tk.Frame(self.content_frame, bg=self.bg_color); header.pack(fill="x", pady=(0, 20))
        self.session_btn = tk.Label(header, text="START SESSION", font=("Inter", 10, "bold"), bg=self.accent_main, fg=self.text_main, padx=15, pady=8, cursor="hand2")
        self.session_btn.pack(side="right", pady=10); self.session_btn.bind("<Button-1>", lambda e: self.toggle_session())
        stats = tk.Frame(header, bg=self.bg_color); stats.pack(anchor="w")
        self.focus_lbl = tk.Label(stats, text="0m", font=("Inter", 48, "bold"), bg=self.bg_color, fg=self.accent_good); self.focus_lbl.pack(side="left", padx=(0, 40))
        self.distract_lbl = tk.Label(stats, text="0m", font=("Inter", 48, "bold"), bg=self.bg_color, fg=self.accent_bad); self.distract_lbl.pack(side="left")
        self.mode_lbl = tk.Label(self.content_frame, text="DAILY TOTALS", font=("Inter", 10, "bold"), bg=self.bg_color, fg=self.text_dim); self.mode_lbl.pack(anchor="w", pady=(0, 20))
        body = tk.Frame(self.content_frame, bg=self.bg_color); body.pack(fill="both", expand=True)
        self.bars = tk.Frame(body, bg=self.bg_color); self.bars.pack(side="left", fill="both", expand=True)
        self.canvas = tk.Canvas(body, width=320, height=320, bg=self.bg_color, highlightthickness=0); self.canvas.pack(side="right", anchor="n")

    def build_page_2(self):
        tk.Label(self.content_frame, text="Activity Trends", font=("Inter", 28, "bold"), bg=self.bg_color, fg=self.text_main).pack(anchor="w")
        self.h_canvas = tk.Canvas(self.content_frame, width=800, height=400, bg=self.bg_color, highlightthickness=0); self.h_canvas.pack(fill="both", expand=True)
        try:
            with urllib.request.urlopen('http://127.0.0.1:5050/history') as r: db = json.loads(r.read().decode())["timeline"]
            dates = [(datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
            mx = max([sum(db.get(d, {}).values()) for d in dates] + [1])
            for i, d in enumerate(dates):
                x = 60 + (i * 105); dy = db.get(d, {}); yb = 350
                for j, (cat, v) in enumerate(dy.items()):
                    h = (v / mx) * 300
                    self.h_canvas.create_rectangle(x, yb-h, x+50, yb, fill=self.chart_colors[j % 5], outline="")
                    yb -= h
                self.h_canvas.create_text(x+25, 375, text=d[-5:], fill=self.text_dim, font=("Inter", 10))
        except Exception as e: logger.warning("Failed to build trends page: %s", e)

    def build_page_3(self):
        tk.Label(self.content_frame, text="Daily Comparison", font=("Inter", 28, "bold"), bg=self.bg_color, fg=self.text_main).pack(anchor="w")
        cv = tk.Canvas(self.content_frame, width=800, height=250, bg=self.bg_color, highlightthickness=0); cv.pack(fill="x", pady=20)
        tk.Label(self.content_frame, text="RECENT SESSIONS", font=("Inter", 12, "bold"), bg=self.bg_color, fg=self.accent_main).pack(anchor="w", pady=(10, 5))
        hist = tk.Frame(self.content_frame, bg=self.bg_color); hist.pack(fill="both", expand=True)
        try:
            with urllib.request.urlopen('http://127.0.0.1:5050/history') as r: resp = json.loads(r.read().decode())
            db = resp["timeline"]; dates = [(datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(4, -1, -1)]
            for i, d in enumerate(dates):
                x = 80 + (i * 150); dy = db.get(d, {})
                pv = dy.get("Productive (School & Career)", 0) + dy.get("Environmental Justice Work", 0)
                dv = dy.get("Distractions", 0)
                cv.create_rectangle(x, 200-(pv*5), x+35, 200, fill=self.accent_good, outline="")
                cv.create_rectangle(x+40, 200-(dv*5), x+75, 200, fill=self.accent_bad, outline="")
                cv.create_text(x+37, 220, text=d[-5:], fill=self.text_dim, font=("Inter", 11))
            for s in resp.get("sessions", [])[::-1][:5]:
                r = tk.Frame(hist, bg=self.nav_bg, pady=8, padx=15); r.pack(fill="x", pady=4)
                tk.Label(r, text=f"{s['start']} - {s['end']}", font=("Inter", 11), bg=self.nav_bg, fg=self.text_main).pack(side="left")
                tk.Label(r, text=f"{s['duration_min']} MIN", font=("Inter", 11, "bold"), bg=self.nav_bg, fg=self.text_dim).pack(side="left", padx=30)
                sc = self.accent_good if s['efficiency'] >= 75 else self.accent_bad
                tk.Label(r, text=f"{s['efficiency']}% FOCUS", font=("Inter", 11, "bold"), bg=self.nav_bg, fg=sc).pack(side="right")
        except Exception as e: logger.warning("Failed to build timeline page: %s", e)

    def update_data(self):
        if self.page == 1:
            try:
                with urllib.request.urlopen('http://127.0.0.1:5050/data') as r: resp = json.loads(r.read().decode())
                self.session_active = resp["session_active"]
                dt = resp["active_session"] if self.session_active else resp["general"]
                self.session_btn.config(text="STOP SESSION" if self.session_active else "START SESSION", bg=self.accent_bad if self.session_active else self.accent_main)
                self.mode_lbl.config(text="SESSION STATS" if self.session_active else "DAILY TOTALS", fg=self.accent_main if self.session_active else self.text_dim)
                tot = sum(dt.values()); pr = dt.get("Productive (School & Career)", 0) + dt.get("Environmental Justice Work", 0)
                self.focus_lbl.config(text=f"{int(pr)}m"); self.distract_lbl.config(text=f"{int(dt.get('Distractions',0))}m")
                eff = int((pr/tot)*100) if tot > 0 else 0
                for w in self.bars.winfo_children(): w.destroy()
                self.canvas.delete("all")
                if tot > 0:
                    sa = 90
                    for i, (c, v) in enumerate(sorted(dt.items(), key=lambda x:x[1], reverse=True)):
                        clr = self.chart_colors[i%5]; pc = (v/tot)*100
                        row = tk.Frame(self.bars, bg=self.bg_color); row.pack(fill="x", pady=8)
                        tk.Label(row, text=c.upper(), font=("Inter", 9, "bold"), bg=self.bg_color, fg=self.text_dim).pack(side="left")
                        tk.Label(row, text=f"{int(pc)}%", font=("Inter", 9, "bold"), bg=self.bg_color, fg=self.text_main).pack(side="right")
                        tr = tk.Frame(row, bg=self.nav_bg, height=4); tr.pack(fill="x", side="bottom", pady=(4,0)); tr.pack_propagate(False)
                        tk.Frame(tr, bg=clr, height=4).place(relwidth=pc/100, relheight=1.0)
                        ex = -(pc/100)*360
                        self.canvas.create_arc(30, 30, 290, 290, start=sa, extent=ex, fill=clr, outline=self.bg_color, width=2)
                        sa += ex
                    self.canvas.create_oval(90, 90, 230, 230, fill=self.bg_color, outline="")
                    self.canvas.create_text(160, 145, text=f"{eff}%", font=("Inter", 42, "bold"), fill=self.text_main)
                    self.canvas.create_text(160, 185, text="EFFICIENCY", font=("Inter", 10, "bold"), fill=self.text_dim)
            except Exception as e: logger.warning("Failed to update dashboard data: %s", e)
        self.root.after(5000, self.update_data)

if __name__ == "__main__":
    root = tk.Tk(); app = DashboardOverlay(root); root.mainloop()
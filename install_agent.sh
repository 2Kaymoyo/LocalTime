#!/bin/bash

SCRIPT="/Users/wilbmoffitt/Desktop/LocalTime/desktop_agent.py"
LOG_OUT="/Users/wilbmoffitt/Desktop/LocalTime/agent_out.log"
LOG_ERR="/Users/wilbmoffitt/Desktop/LocalTime/agent_err.log"

echo "Installing LocalTime Desktop Agent..."

# Kill any existing agent
pkill -f "desktop_agent.py" 2>/dev/null
sleep 1

# Start agent in background
nohup python3 "$SCRIPT" > "$LOG_OUT" 2> "$LOG_ERR" &
echo "Desktop Agent started (PID: $!)"
echo "Logs: $LOG_OUT"

# Add to login items via a simple cron job check
CRON_CMD="@reboot nohup python3 $SCRIPT > $LOG_OUT 2> $LOG_ERR &"
(crontab -l 2>/dev/null | grep -v "desktop_agent.py"; echo "$CRON_CMD") | crontab -
echo "Added to startup via crontab."
echo "Done!"

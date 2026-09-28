@echo off
rem Race Control Board launcher. Pass --demo to try it without iRacing running.
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python server.py %*
pause

@echo off
title VoiceGuard AI Server
echo ========================================================
echo          Starting VoiceGuard AI Platform
echo ========================================================
echo.
echo Model: Spectra-AASIST3 (Local Deepfake Detection Engine)
echo Opening http://localhost:8000 in your browser...
echo.
start http://localhost:8000
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
pause

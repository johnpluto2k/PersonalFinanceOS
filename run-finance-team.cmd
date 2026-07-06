@echo off
title PersonalFinanceOS - Build Team
cd /d "C:\ClaudeProjects\PersonalFinanceOS"
echo ============================================================
echo   PersonalFinanceOS - Build Team
echo   Builds the next app feature (plan -> code -> screenshot
echo   check -> money-math audit -> review).
echo   It will PAUSE and ask you to approve twice per feature:
echo     Gate 1 = approve the plan
echo     Gate 2 = approve before it commits
echo ============================================================
echo.
echo Launching Claude Code in the PersonalFinanceOS folder...
echo (If it does not start on its own, paste this line:)
echo     Work through team_run_prompt.md, one feature at a time
echo.
claude "Work through team_run_prompt.md, one feature at a time. Stop and ask me for approval at Gate 1 (plan) and Gate 2 (before committing)."

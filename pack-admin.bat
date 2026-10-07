@echo off
REM 以管理员身份运行本文件即可正常打包（解决 winCodeSign 符号链接权限问题）
cd /d "D:\杨标的工作文件\项目\SynologyDrive\局域网沟通广播项目"
call npm run pack
pause

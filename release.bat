@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "REPO_URL=https://github.com/lovesnsfi/teaching_partner"

echo ============================================================
echo   局域网沟通广播 - 一键发布
echo   用法: release.bat [patch^|minor^|major^|版本号]
echo          不带参数 = patch，例如 0.2.3 -^> 0.2.4
echo ============================================================
echo.

REM ------------------------------------------------------------
REM 0. 基本检查
REM ------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 git，请先安装并加入 PATH。
  goto :fail
)
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node，请先安装并加入 PATH。
  goto :fail
)

git rev-parse --git-dir >nul 2>nul
if errorlevel 1 (
  echo [错误] 当前目录不是 git 仓库。
  goto :fail
)

set "BRANCH="
for /f "usebackq delims=" %%b in (`git rev-parse --abbrev-ref HEAD`) do set "BRANCH=%%b"
if "!BRANCH!"=="HEAD" (
  echo [错误] 当前处于 detached HEAD 状态，请先切回 dev 分支。
  goto :fail
)

REM ------------------------------------------------------------
REM 1. 工作区必须干净（否则 tag 会指向不完整的代码）
REM ------------------------------------------------------------
set "DIRTY="
for /f "usebackq delims=" %%f in (`git status --porcelain`) do set "DIRTY=1"
if defined DIRTY (
  echo [错误] 工作区有未提交的改动，请先提交或撤销后再发布：
  git status --short
  echo.
  goto :fail
)

set "OLDVER="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "OLDVER=%%v"
if not defined OLDVER (
  echo [错误] 无法读取 package.json 里的版本号。
  goto :fail
)

echo 当前版本: !OLDVER!
echo.

REM ------------------------------------------------------------
REM 2. 升级版本号
REM ------------------------------------------------------------
set "BUMP=%~1"
if not defined BUMP set "BUMP=patch"

if /i "!BUMP!"=="major"    goto :bump
if /i "!BUMP!"=="minor"    goto :bump
if /i "!BUMP!"=="patch"    goto :bump
REM 形如 x.y.z 的显式版本号
echo !BUMP! | findstr /r /c:"^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo [错误] 无法识别的版本参数: !BUMP!
  echo        只接受 patch / minor / major 或形如 0.2.3 的版本号。
  goto :fail
)

:bump
echo [1/5] 升级版本号 (!BUMP!) ...
call npm version !BUMP! --no-git-tag-version
if errorlevel 1 (
  echo [错误] npm version 执行失败。
  goto :fail
)

set "NEWVER="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "NEWVER=%%v"
set "TAG=v!NEWVER!"
echo       !OLDVER!  -^>  !NEWVER!    tag = !TAG!
echo.

REM ------------------------------------------------------------
REM 3. 提交版本号
REM ------------------------------------------------------------
echo [2/5] 提交版本号 ...
git add package.json package-lock.json
git commit -m "版本号升为 !NEWVER!"
if errorlevel 1 (
  echo [错误] 提交失败。
  goto :fail
)
echo.

REM ------------------------------------------------------------
REM 4. 打 tag 前自检 —— 顺序错了在这里就会被拦住
REM ------------------------------------------------------------
echo [3/5] 自检 ...

REM 4.1 同名 tag 不能已存在
git rev-parse -q --verify refs/tags/!TAG! >nul 2>nul
if not errorlevel 1 (
  echo [错误] 本地已存在 tag !TAG!，请先处理: git tag -d !TAG!
  goto :fail
)
for /f %%t in (`git ls-remote --tags origin refs/tags/!TAG! 2^>nul`) do (
  echo [错误] 远端已存在 tag !TAG!，请先在 GitHub 上删除或换个版本号。
  goto :fail
)

REM 4.2 关键校验：即将打下的这个提交里，package.json 版本必须等于 tag 版本
REM     electron-builder 是按 package.json 的 version 决定发布到哪个 Release 的，
REM     二者不一致会把产物传到旧版本上，GitHub 自动建的 Release 里只剩源码包。
for /f "usebackq delims=" %%v in (`git show HEAD:package.json ^| node -p "require('fs').readFileSync(0,'utf8')"`) do set "COMMITVER=%%v"
if not "!COMMITVER!"=="!NEWVER!" (
  echo [错误] 提交里的版本 (!COMMITVER!) 与目标 tag (!TAG!) 不一致，已中止。
  goto :fail
)
echo       tag 版本一致性检查通过 (!TAG!)

REM 4.3 确认 tag 会落在最新提交上
git tag !TAG!
for /f "usebackq delims=" %%c in (`git rev-list -n 1 !TAG!`) do set "TAGSHA=%%c"
for /f "usebackq delims=" %%c in (`git rev-parse HEAD`) do set "HEADSHA=%%c"
if not "!TAGSHA!"=="!HEADSHA!" (
  echo [错误] tag 未指向最新提交，已回滚本地 tag。
  git tag -d !TAG!
  goto :fail
)
echo       tag !TAG! 已指向最新提交
echo.

REM ------------------------------------------------------------
REM 5. 推送：先分支，后 tag（tag 推送才会触发 Actions）
REM ------------------------------------------------------------
echo [4/5] 推送分支 !BRANCH! ...
git push origin !BRANCH!
if errorlevel 1 (
  echo [错误] 分支推送失败，tag 未推送（CI 不会触发），可修正后重试。
  goto :fail
)
echo.

echo [5/5] 推送 tag !TAG! 以触发 GitHub Actions ...
git push origin !TAG!
if errorlevel 1 (
  echo [错误] tag 推送失败。可修正网络后单独执行: git push origin !TAG!
  goto :fail
)

echo.
echo ============================================================
echo   发布完成
echo --------------------------------------------------------
echo   版本: !NEWVER!
echo   tag : !TAG!
echo   分支: !BRANCH!
echo.
echo   稍等 2-5 分钟，构建完成后可在以下地址查看进度:
echo   !REPO_URL!/actions
echo   发布完成后检查 exe 是否就位:
echo   !REPO_URL!/releases/tag/!TAG!
echo.
echo   若 Actions 失败，点开对应运行记录，Diagnostics 步骤会
echo   在摘要页输出 electron-builder 的最后 100 行日志。
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo --------------------------------------------------------
echo   已中止，未推送任何内容（本地改动仍保留）。
echo --------------------------------------------------------
echo.
pause
exit /b 1

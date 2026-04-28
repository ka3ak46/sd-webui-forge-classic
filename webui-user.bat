@echo off
git pull

:: set PYTHON=
:: set GIT=
:: set VENV_DIR=

set COMMANDLINE_ARGS= --uv --nunchaku --bnb --cuda-malloc --onnxruntime-gpu --reserve-vram 2
:: --xformers --enable-insecure-extension-access --sage --uv
:: --pin-shared-memory --cuda-malloc --cuda-stream 
:: --skip-python-version-check --skip-torch-cuda-test --skip-version-check --skip-prepare-environment --skip-install

call webui.bat

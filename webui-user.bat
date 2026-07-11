@echo off

:: set PYTHON=
:: set GIT=
:: set VENV_DIR=

<<<<<<< HEAD
set COMMANDLINE_ARGS= --uv --nunchaku --bnb --cuda-malloc --onnxruntime-gpu --reserve-vram 2
=======
set COMMANDLINE_ARGS= --uv --xformers --cuda-malloc --autolaunch
>>>>>>> 7b96dd00efe03a7c57c1d4ac543f8c2bd68a2c5b

:: --xformers --sage --uv
:: --pin-shared-memory --cuda-malloc --cuda-stream
:: --skip-python-version-check --skip-torch-cuda-test --skip-version-check --skip-prepare-environment --skip-install

call webui.bat

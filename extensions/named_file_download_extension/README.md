# downloade named file

Load this folder separately using **Load unpacked** at `chrome://extensions`.
It uses the existing popup.js code to download an HTTP(S) URL or stream a
selected local file in 64 KiB chunks. Open the demo in a tab before selecting
a file and keep the tab open during streaming.

The streaming form requires your modified Chromium build. A small sample file is
included at `test_files/SimpleFile.txt`; you can also choose your own larger files.

The "Stream finished" message means Finish returned. To confirm the file has
finished saving, check its completed state in `chrome://downloads/`.

The generated-data benchmark is a separate extension named **download unknown file**
in ../downloads_api_extension. Both extensions can be loaded at the same time.

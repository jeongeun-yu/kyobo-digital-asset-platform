@echo off
setlocal

set MAVEN_VERSION=3.9.6
set MAVEN_DIR=%~dp0.mvn\wrapper\apache-maven-%MAVEN_VERSION%
set MAVEN_ZIP=%~dp0.mvn\wrapper\apache-maven-%MAVEN_VERSION%-bin.zip
set MAVEN_URL=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/%MAVEN_VERSION%/apache-maven-%MAVEN_VERSION%-bin.zip

if not exist "%MAVEN_DIR%\bin\mvn.cmd" (
    echo Downloading Maven %MAVEN_VERSION%...
    powershell -Command "& {Invoke-WebRequest -Uri '%MAVEN_URL%' -OutFile '%MAVEN_ZIP%'}"
    powershell -Command "& {Expand-Archive -Path '%MAVEN_ZIP%' -DestinationPath '%~dp0.mvn\wrapper\' -Force}"
    del "%MAVEN_ZIP%"
)

"%MAVEN_DIR%\bin\mvn.cmd" %*
endlocal

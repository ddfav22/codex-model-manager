!macro customInit
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${StdUtils.GetParameter} $R9 "D" ""

  ${If} $R8 == ""
  ${AndIf} $R9 == ""
    StrCpy $INSTDIR "$EXEDIR\${PRODUCT_FILENAME}"
  ${EndIf}
!macroend

!macro customInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
!macroend

!macro customRemoveFiles
  FindFirst $R8 $R9 "$INSTDIR\*.*"

removeFilesLoop:
  StrCmp $R9 "" removeFilesDone
  StrCmp $R9 "." removeFilesNext
  StrCmp $R9 ".." removeFilesNext
  StrCmp $R9 "data" removeFilesNext

  IfFileExists "$INSTDIR\$R9\*.*" removeFilesDirectory removeFilesFile

removeFilesDirectory:
  RMDir /r "$INSTDIR\$R9"
  Goto removeFilesNext

removeFilesFile:
  SetFileAttributes "$INSTDIR\$R9" NORMAL
  Delete "$INSTDIR\$R9"

removeFilesNext:
  FindNext $R8 $R9
  Goto removeFilesLoop

removeFilesDone:
  FindClose $R8
  RMDir "$INSTDIR"
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
!macroend

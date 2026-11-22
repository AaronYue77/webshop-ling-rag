@echo off
setlocal
title WebShop
set "WEBSHOP_FRONT_ROOT=%~dp0web"
powershell.exe -NoLogo -NoProfile -Command "Add-Type -Path (Join-Path $env:WEBSHOP_FRONT_ROOT 'relay.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Net.Http.dll','System.Web.Extensions.dll') -ErrorAction Stop; [WebShopFront]::Run($env:WEBSHOP_FRONT_ROOT,$true)"
if errorlevel 1 pause

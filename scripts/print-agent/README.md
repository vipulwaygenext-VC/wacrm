# Hindrishi label print agent (Windows)

Prints Shiprocket labels automatically on the office laptop.

**Setup (once):** double-click `INSTALL.bat`, paste the CRM secret (`AUTOMATION_CRON_SECRET`), pick the
label printer. It installs into `%LOCALAPPDATA%\HindrishiPrint` and
starts with Windows.

**What prints:** any Shopify order tagged `Label-Ready` (set by the CRM
after booking Shiprocket) and not yet `Label-Printed`.

**Stop / remove:** Task Scheduler → *Hindrishi Label Printer* → End /
Delete. Log: `%LOCALAPPDATA%\HindrishiPrint\print-agent.log`.

# SPDX-License-Identifier: AGPL-3.0-only
"""Format a private working copy in memory; never save the workbook."""
import math
import unicodedata
from pathlib import Path
import subprocess
import sys
import time
import uuid
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.document.MacroExecMode import NEVER_EXECUTE
from com.sun.star.document.UpdateDocMode import NO_UPDATE
from com.sun.star.sheet.CellFlags import VALUE, DATETIME, STRING, FORMULA

def prop(name, value):
    result = PropertyValue()
    result.Name, result.Value = name, value
    return result

def readable_records(desktop, document):
    # Recognize only a small, static, single-sheet table of repeated label/value
    # row pairs. Render those pairs down the page without interpreting the labels.
    if document.Sheets.Count != 1:
        return document, False
    sheet = document.Sheets.getByIndex(0)
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(False)
    area = cursor.RangeAddress
    rows, columns = area.EndRow + 1, area.EndColumn + 1
    if rows < 2 or rows > 12 or rows % 2 or columns < 12 or columns < rows * 3 or sheet.DrawPage.Count or sheet.getPrintAreas():
        return document, False
    cells = sheet.getCellRangeByPosition(0, 0, columns - 1, rows - 1)
    if cells.queryContentCells(FORMULA).Cells.createEnumeration().hasMoreElements():
        return document, False
    if any(not sheet.Columns.getByIndex(c).IsVisible for c in range(columns)) or any(not sheet.Rows.getByIndex(r).IsVisible for r in range(rows)):
        return document, False
    records = []
    for row in range(0, rows, 2):
        labels = [sheet.getCellByPosition(c, row).String for c in range(columns)]
        values = [sheet.getCellByPosition(c, row + 1).String for c in range(columns)]
        if not labels[0] or labels[0] != values[0] or sum(bool(label) for label in labels) < columns // 2:
            return document, False
        if any(sheet.getCellByPosition(c, row).Type.value != 'TEXT' for c in range(columns) if labels[c]):
            return document, False
        records.append((labels[0], [(label, value) for label, value in zip(labels[1:], values[1:]) if label or value]))
    rendered = desktop.loadComponentFromURL('private:factory/scalc', '_blank', 0, (prop('Hidden', True), prop('MacroExecutionMode', NEVER_EXECUTE), prop('UpdateDocMode', NO_UPDATE)))
    for index, (title, pairs) in enumerate(records):
        if index:
            rendered.Sheets.insertNewByName('Record ' + str(index + 1), index)
        target = rendered.Sheets.getByIndex(index)
        target.getCellRangeByPosition(0, 0, 1, 0).merge(True)
        target.getCellByPosition(0, 0).setString(title)
        target.getCellRangeByPosition(0, 0, 1, 0).CharWeight = 150
        for row, (label, value) in enumerate(pairs, 1):
            target.getCellByPosition(0, row).setString(label)
            target.getCellByPosition(1, row).setString(value)
        target.getCellRangeByPosition(0, 0, 1, len(pairs)).CharHeight = 11
    document.setModified(False)
    document.close(True)
    return rendered, True

source, output, profile = map(Path, sys.argv[1:])
pipe = 'workflow_' + uuid.uuid4().hex
process = subprocess.Popen(['libreoffice', '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo', '--nodefault', '--norestore', '--accept=pipe,name=' + pipe + ';urp;StarOffice.ServiceManager'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
document = None
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    context = None
    for attempt in range(200):
        if process.poll() is not None:
            raise RuntimeError('Spreadsheet renderer stopped')
        try:
            context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
            break
        except Exception:
            time.sleep(.1)
    if context is None:
        raise RuntimeError('Spreadsheet renderer did not start')
    desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
    document = desktop.loadComponentFromURL(source.as_uri(), '_blank', 0, (prop('Hidden', True), prop('ReadOnly', False), prop('UpdateDocMode', NO_UPDATE), prop('MacroExecutionMode', NEVER_EXECUTE)))
    if document is None or not document.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
        raise RuntimeError('Not a supported spreadsheet')
    document, records_layout = readable_records(desktop, document)
    styles = document.StyleFamilies.getByName('PageStyles')
    for sheet in document.Sheets:
        if not sheet.IsVisible:
            continue
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        area = cursor.RangeAddress
        cells = sheet.getCellRangeByPosition(0, 0, area.EndColumn, area.EndRow)
        # Keep cell values, formulas and number formats. Only the temporary
        # document's printing geometry and text layout change.
        hidden = []
        for index in range(area.EndColumn + 1):
            column = sheet.Columns.getByIndex(index)
            if not column.IsVisible:
                hidden.append(index)
                continue
            if records_layout:
                column.Width = 10000 if index == 0 else 8000
            else:
                column.OptimalWidth = True
                column.Width = max(1400, min(column.Width, 1800))
        cells.IsTextWrapped = True
        numbers = cells.queryContentCells(VALUE | DATETIME)
        if numbers.Count:
            numbers.IsTextWrapped = False
            numbers.ShrinkToFit = True
        # Headless Calc can leave wrapped rows at their imported fixed height.
        # Give each text row enough room using conservative glyph widths; keep
        # values/formulas untouched and reject a native height cap rather than clip.
        heights = {}
        contents = cells.queryContentCells(STRING | FORMULA).Cells.createEnumeration()
        while contents.hasMoreElements():
            cell = contents.nextElement()
            address = cell.CellAddress
            column = sheet.Columns.getByIndex(address.Column)
            if not column.IsVisible:
                continue
            text = cell.String
            font = float(cell.CharHeight or 11)
            width = max(1, column.Width * 72 / 2540 - 6)
            lines = 0
            for line in text.split('\n'):
                units = sum(0 if unicodedata.combining(char) else 1.15 if unicodedata.east_asian_width(char) in ('W', 'F') else .75 for char in line)
                lines += max(1, math.ceil(units * font / width))
            needed = math.ceil((lines * font * 1.45 + 6) * 2540 / 72)
            heights[address.Row] = max(heights.get(address.Row, 0), needed)
        for index, needed in heights.items():
            row = sheet.Rows.getByIndex(index)
            if row.IsVisible:
                row.OptimalHeight = False
                row.Height = max(row.Height, needed)
                if row.Height + 10 < needed:
                    raise RuntimeError('Spreadsheet row cannot fit without clipping')
        for index in hidden:
            sheet.Columns.getByIndex(index).IsVisible = False
        style = styles.getByName(sheet.PageStyle)
        style.IsLandscape = not records_layout
        style.Width, style.Height = (21000, 29700) if records_layout else (42000, 29700)  # A3 landscape; long tables continue downwards.
        style.LeftMargin = style.RightMargin = 1000
        style.TopMargin = style.BottomMargin = 1000
        style.ScaleToPages = 0
        style.ScaleToPagesX = 1
        style.ScaleToPagesY = 0
    document.storeToURL(output.as_uri(), (prop('FilterName', 'calc_pdf_Export'), prop('Overwrite', True)))
finally:
    if document is not None:
        try:
            document.setModified(False)
            document.close(True)
        except Exception:
            pass
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

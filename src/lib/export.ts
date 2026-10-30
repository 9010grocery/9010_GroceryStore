import { downloadCsv } from './format'

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'
export type ExportCell = string | number

export interface ExportTable {
  /** File name without the extension, e.g. "inventory-2026-10-20". */
  filename: string
  /** Shown above the table in the PDF and as the sheet name in Excel. */
  title: string
  headers: string[]
  rows: ExportCell[][]
  /** Line under the title in the PDF, e.g. the date range. */
  subtitle?: string
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Saves the table as CSV, Excel (.xlsx) or PDF. The Excel and PDF code is only loaded when it is used. */
export async function exportTable(format: ExportFormat, table: ExportTable) {
  if (format === 'csv') { downloadCsv(`${table.filename}.csv`, table.headers, table.rows); return }

  if (format === 'xlsx') {
    const XLSX = await import('xlsx')
    const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows])
    sheet['!cols'] = table.headers.map((header, column) => ({ wch: Math.min(40, Math.max(header.length, ...table.rows.map((row) => String(row[column] ?? '').length)) + 2) }))
    const book = XLSX.utils.book_new()
    // Sheet names allow 31 characters and no : \ / ? * [ ]
    XLSX.utils.book_append_sheet(book, sheet, table.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Export')
    const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
    save(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${table.filename}.xlsx`)
    return
  }

  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ orientation: table.headers.length > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' })
  // The built-in PDF fonts have no peso sign, so it is written as PHP.
  const text = (value: ExportCell) => String(value ?? '').replace(/₱/g, 'PHP ').replace(/[–—]/g, '-')
  doc.setFontSize(14)
  doc.text(text(table.title), 40, 42)
  doc.setFontSize(9)
  doc.setTextColor(110)
  doc.text(text(table.subtitle ?? `Generated ${new Date().toLocaleString('en-PH')}`), 40, 58)
  autoTable(doc, {
    startY: 72,
    head: [table.headers.map(text)],
    body: table.rows.map((row) => row.map(text)),
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [58, 74, 48] },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      doc.setFontSize(8)
      doc.setTextColor(120)
      doc.text(`Page ${doc.getNumberOfPages()}`, doc.internal.pageSize.getWidth() - 70, doc.internal.pageSize.getHeight() - 20)
    },
  })
  doc.save(`${table.filename}.pdf`)
}

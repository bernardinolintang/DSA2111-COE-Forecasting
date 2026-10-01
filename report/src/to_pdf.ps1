# Renders the report with Microsoft Word (read-only) to a PDF and prints the page count.
#   pwsh report/src/to_pdf.ps1 <docx path> <pdf path>
param(
    [Parameter(Mandatory = $true)][string]$Docx,
    [Parameter(Mandatory = $true)][string]$Pdf
)
$word = New-Object -ComObject Word.Application
# If Word handed back an instance that already has documents open (the author's
# own window), leave that instance and its windows alone when we finish.
$ownInstance = ($word.Documents.Count -eq 0)
if ($ownInstance) { $word.Visible = $false; $word.DisplayAlerts = 0 }
try {
    # Open(FileName, ConfirmConversions, ReadOnly)
    $doc = $word.Documents.Open((Resolve-Path $Docx).Path, $false, $true)
    $doc.SaveAs2([string]$Pdf, 17)                       # 17 = wdFormatPDF
    $pages = $doc.ComputeStatistics(2)                   # 2 = wdStatisticPages
    $words = $doc.ComputeStatistics(0)                   # 0 = wdStatisticWords
    Write-Output "pages=$pages words=$words"
    $doc.Close($false)
}
finally {
    if ($ownInstance) { $word.Quit() }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

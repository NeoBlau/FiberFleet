// Заглушки для выгрузки файлов (Excel/PDF/импорт) — в демо-версии в браузере недоступны
const fail = () => { const e = new Error('В демо-версии файлы не формируются — выгрузка в Excel, PDF и импорт из 1С работают в полной версии на сервере'); e.status = 400; throw e; };
export class Workbook { constructor() { fail(); } }
export default class PDFDocument { constructor() { fail(); } }
export const ExcelJS = { Workbook };

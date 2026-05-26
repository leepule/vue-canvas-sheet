export const defaultToolbarGroups = {
	history: { compact: false, minWidth: 80, priority: 1, icon: 'undo' },
	cells: { compact: false, minWidth: 100, priority: 2, icon: 'merge-cells' },
	font: { compact: false, minWidth: 220, priority: 3, icon: 'bold' },
	alignment: { compact: false, minWidth: 200, priority: 4, icon: 'align-left' },
	numbers: { compact: false, minWidth: 130, priority: 5, icon: 'percent' },
	table: { compact: false, minWidth: 90, priority: 6, icon: 'border-all' },
	freeze: { compact: false, minWidth: 70, priority: 7, icon: 'pin' },
	data: { compact: false, minWidth: 110, priority: 8, icon: 'find' }
};

export const defaultToolbarVisible = ['history', 'cells', 'font', 'alignment', 'numbers', 'table', 'freeze', 'data'];

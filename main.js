'use strict';

var obsidian = require('obsidian');

// ============================================================
// 1. ОСНОВНОЙ КЛАСС ПЛАГИНА
// ============================================================

class YandexCalendarIntegrationPlugin extends obsidian.Plugin {
    settings = null;
    secureSettings = null;

    // ===== ЖИЗНЕННЫЙ ЦИКЛ =====
    async onload() {
        console.log('Yandex Calendar plugin is starting...');
        this.initializePlugin();
    }

    async initializePlugin() {
        try {
            this.secureSettings = new SecureSettings(this);
            await this.loadSettings();
            this.addSettingTab(new YandexCalendarIntegrationSettingTab(this.app, this));
            this.registerCommands();
        } catch (error) {
            console.error('Failed to initialize plugin:', error);
            new Notice('Failed to initialize Yandex Calendar plugin');
        }
    }

    // ===== КОМАНДЫ =====
    registerCommands() {
        // Команда 1: Вставка встреч
        this.addCommand({
            id: 'insert-events-from-yandex-calendar-at-cursor',
            name: 'Вставить встречи в позицию курсора',
            editorCallback: (editor) => {
                this.insertEvents(editor);
            }
        });

        // Команда 2: Вставка списков дел
        this.addCommand({
            id: 'insert-todos-from-yandex-calendar-at-cursor',
            name: 'Вставить списки дел в позицию курсора',
            editorCallback: (editor) => {
                this.insertTodos(editor);
            }
        });
    }

    // ============================================================
    // 2. ВСТАВКА ВСТРЕЧ
    // ============================================================

    async insertEvents(editor) {
        try {
            if (!this.validateSecurityRequirements()) return;

            const events = await this.getEvents();
            if (events.length === 0) {
                new Notice('Нет встреч на сегодня');
                return;
            }

            const pattern = this.settings.pattern;
            const sortedEvents = events.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
            const formattedEvents = await this.formatEventsByPattern(sortedEvents, pattern);

            const cursor = editor.getCursor();
            editor.replaceRange(formattedEvents, cursor);
        } catch (error) {
            console.error('Failed to insert events:', error);
            new Notice('Ошибка вставки встреч');
        }
    }

    async getEvents() {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();
            if (!email || !password) return [];

            const currentDate = this.getCurrentDailyNoteDate();
            if (!currentDate) return [];

            const collections = await this.findCollections();
            let allEvents = [];

            for (const collectionUrl of collections) {
                // Пропускаем коллекции с задачами
                if (collectionUrl.includes('todos-')) continue;

                const data = await this.requestCollection(collectionUrl);
                if (data) {
                    const parsedEvents = this.parseCalendarEvents(data);
                    const withDate = parsedEvents.filter(e => e && e.dateStart);
                    allEvents = allEvents.concat(withDate);
                }
            }

            // Дедупликация
            const uniqueEvents = this.deduplicateEvents(allEvents);

            // Фильтрация по дате
            return this.filterEventsByDate(uniqueEvents, currentDate);
        } catch (error) {
            console.error('Failed to get events:', error);
            return [];
        }
    }

    deduplicateEvents(events) {
        const unique = [];
        const seenUrls = new Set();

        for (const event of events) {
            if (!event.url) {
                unique.push(event);
                continue;
            }
            if (!seenUrls.has(event.url)) {
                seenUrls.add(event.url);
                unique.push(event);
            }
        }
        return unique;
    }

    filterEventsByDate(events, targetDate) {
        return events.filter(event => {
            if (!event || !event.dateStart) return false;
            const eventDate = new Date(event.dateStart);
            const target = new Date(targetDate);
            return eventDate.getFullYear() === target.getFullYear() &&
                   eventDate.getMonth() === target.getMonth() &&
                   eventDate.getDate() === target.getDate();
        });
    }

    // ============================================================
    // 3. ВСТАВКА СПИСКОВ ДЕЛ
    // ============================================================

    async insertTodos(editor) {
        try {
            if (!this.validateSecurityRequirements()) return;

            const todoLists = await this.getTodoLists();
            if (todoLists.length === 0) {
                new Notice('Списки дел пусты');
                return;
            }

            const formattedText = this.formatTodoLists(todoLists);
            const cursor = editor.getCursor();
            editor.replaceRange(formattedText, cursor);
        } catch (error) {
            console.error('Failed to insert todos:', error);
            new Notice('Ошибка вставки списков дел');
        }
    }

    async getTodoLists() {
        try {
            const collections = await this.findCollections();
            const todoLists = [];

            for (const collectionUrl of collections) {
                if (!collectionUrl.includes('todos-')) continue;

                const data = await this.requestCollection(collectionUrl);
                if (!data) continue;

                const tasks = this.parseTodoTasks(data);
                if (tasks.length === 0) continue;

                const listName = await this.getCollectionName(collectionUrl);
                todoLists.push({ name: listName, tasks });
            }

            return todoLists;
        } catch (error) {
            console.error('Failed to get todo lists:', error);
            return [];
        }
    }

    formatTodoLists(todoLists) {
        let result = '';
        for (const list of todoLists) {
            result += `**${list.name}**\n`;
            for (const task of list.tasks) {
                result += `  - [ ] ${task}\n`;
            }
            result += '\n';
        }
        return result;
    }

    // ============================================================
    // 4. РАБОТА С КОЛЛЕКЦИЯМИ
    // ============================================================

    async findCollections() {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();
            if (!email || !password) return [];

            const token = btoa(`${email}:${password}`);
            const baseUrl = `https://caldav.yandex.ru/calendars/${email}/`;

            const xmlPropFind = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:prop>
        <d:resourcetype/>
        <d:displayname/>
    </d:prop>
</d:propfind>`;

            const response = await requestUrl({
                url: baseUrl,
                method: 'PROPFIND',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Depth': '1'
                },
                body: xmlPropFind
            });

            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(response.text, 'text/xml');

            const hrefs = xmlDoc.getElementsByTagNameNS('DAV:', 'href');
            const collections = [];

            for (let i = 0; i < hrefs.length; i++) {
                const href = hrefs[i].textContent;
                if (href && href !== `/calendars/${encodeURIComponent(email)}/`) {
                    const url = href.startsWith('http') ? href : `https://caldav.yandex.ru${href}`;
                    if (!url.includes('inbox') && !url.includes('outbox')) {
                        collections.push(url);
                    }
                }
            }

            return collections;
        } catch (error) {
            console.error('Error finding collections:', error);
            return [];
        }
    }

    async requestCollection(collectionUrl) {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();
            if (!email || !password) return null;

            const token = btoa(`${email}:${password}`);

            // Выбираем тип запроса
            const body = collectionUrl.includes('todos-')
                ? this.buildTodoQuery()
                : this.buildEventQuery();

            const urlObj = new URL(collectionUrl);
            const response = await requestUrl({
                url: `https://caldav.yandex.ru${urlObj.pathname}`,
                method: 'REPORT',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml',
                    'Depth': '1'
                },
                body: body
            });

            return response.text;
        } catch (error) {
            console.error(`Error requesting ${collectionUrl}:`, error);
            return null;
        }
    }

    async getCollectionName(collectionUrl) {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();
            if (!email || !password) return 'Список дел';

            const token = btoa(`${email}:${password}`);

            const xmlPropFind = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
    <d:prop>
        <d:displayname/>
    </d:prop>
</d:propfind>`;

            const urlObj = new URL(collectionUrl);
            const response = await requestUrl({
                url: `https://caldav.yandex.ru${urlObj.pathname}`,
                method: 'PROPFIND',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Depth': '0'
                },
                body: xmlPropFind
            });

            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(response.text, 'text/xml');
            const displayName = xmlDoc.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent;

            return displayName || 'Список дел';
        } catch (error) {
            console.error('Error getting collection name:', error);
            return 'Список дел';
        }
    }

    // ============================================================
    // 5. ЗАПРОСЫ (XML)
    // ============================================================

    buildTodoQuery() {
        return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:prop>
        <c:calendar-data>
            <c:comp name="VCALENDAR">
                <c:comp name="VTODO">
                    <c:prop name="SUMMARY"/>
                    <c:prop name="DUE"/>
                    <c:prop name="STATUS"/>
                </c:comp>
            </c:comp>
        </c:calendar-data>
    </d:prop>
    <c:filter>
        <c:comp-filter name="VCALENDAR">
            <c:comp-filter name="VTODO"/>
        </c:comp-filter>
    </c:filter>
</c:calendar-query>`;
    }

    buildEventQuery() {
        const currentDate = this.getCurrentDailyNoteDate();
        if (!currentDate) return this.buildEmptyQuery();

        const { start, end } = this.getDateRange(currentDate);

        return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:prop>
        <D:getetag/>
        <C:calendar-data>
            <C:comp name="VCALENDAR">
                <C:comp name="VEVENT">
                    <C:prop name="SUMMARY"/>
                    <C:prop name="DTSTART"/>
                    <C:prop name="DTEND"/>
                    <C:prop name="DESCRIPTION"/>
                    <C:prop name="URL"/>
                </C:comp>
                <C:comp name="VTIMEZONE"/>
            </C:comp>
        </C:calendar-data>
    </D:prop>
    <C:filter>
        <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VEVENT">
                <C:time-range start="${start}" end="${end}"/>
            </C:comp-filter>
        </C:comp-filter>
    </C:filter>
</C:calendar-query>`;
    }

    buildEmptyQuery() {
        return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:prop>
        <C:calendar-data/>
    </D:prop>
</C:calendar-query>`;
    }

    // ============================================================
    // 6. ПАРСИНГ
    // ============================================================

    parseCalendarEvents(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const responses = xmlDoc.getElementsByTagNameNS('DAV:', 'response');

        const events = [];

        for (const response of responses) {
            try {
                const calendarData = response.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-data')[0];
                if (!calendarData) continue;

                const icalText = calendarData.textContent;
                const veventMatch = icalText.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);

                if (veventMatch) {
                    const event = this.parseYandexCalendar(veventMatch[1]);
                    if (event) events.push(event);
                }
            } catch (error) {
                console.error('Error parsing event:', error);
            }
        }

        return events;
    }

    parseYandexCalendar(data) {
        const lines = String(data).split('\n');
        const eventData = {};

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('SUMMARY:')) {
                eventData.summary = trimmed.substring(8);
            } else if (trimmed.startsWith('DTSTART;TZID=')) {
                const dateStr = trimmed.substring(trimmed.indexOf(':') + 1);
                eventData.dateStart = this.parseYandexCalendarDate(dateStr);
                eventData.allDay = false;
            } else if (trimmed.startsWith('DTSTART;VALUE=DATE:')) {
                const dateStr = trimmed.substring(trimmed.indexOf(':') + 1);
                eventData.dateStart = this.parseAllDayDate(dateStr);
                eventData.allDay = true;
            } else if (trimmed.startsWith('DTSTART:')) {
                const dateStr = trimmed.substring(8);
                if (dateStr.length === 8) {
                    eventData.dateStart = this.parseAllDayDate(dateStr);
                    eventData.allDay = true;
                } else {
                    eventData.dateStart = this.parseYandexCalendarDate(dateStr);
                    eventData.allDay = false;
                }
            } else if (trimmed.startsWith('DTEND;TZID=')) {
                const dateStr = trimmed.substring(trimmed.indexOf(':') + 1);
                eventData.dateEnd = this.parseYandexCalendarDate(dateStr);
            } else if (trimmed.startsWith('DTEND;VALUE=DATE:')) {
                const dateStr = trimmed.substring(trimmed.indexOf(':') + 1);
                eventData.dateEnd = this.parseAllDayDate(dateStr);
            } else if (trimmed.startsWith('DTEND:')) {
                const dateStr = trimmed.substring(6);
                eventData.dateEnd = dateStr.length === 8
                    ? this.parseAllDayDate(dateStr)
                    : this.parseYandexCalendarDate(dateStr);
            } else if (trimmed.startsWith('DESCRIPTION:')) {
                eventData.description = trimmed.substring(12);
            } else if (trimmed.startsWith('URL:')) {
                eventData.url = trimmed.substring(4);
            }
        }

        if (!eventData.dateStart) return null;

        const timeStart = eventData.allDay ? '' : this.getTimeOnly(eventData.dateStart);
        const timeEnd = eventData.allDay ? '' : this.getTimeOnly(eventData.dateEnd || eventData.dateStart);

        return new CalendarEventDto(
            eventData.summary || 'Без названия',
            eventData.dateStart,
            eventData.dateEnd || eventData.dateStart,
            timeStart,
            timeEnd,
            eventData.description || '',
            eventData.url || '',
            eventData.allDay || false
        );
    }

    parseTodoTasks(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const responses = xmlDoc.getElementsByTagNameNS('DAV:', 'response');

        const tasks = [];

        for (const response of responses) {
            try {
                const calendarData = response.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-data')[0];
                if (!calendarData) continue;

                const icalText = calendarData.textContent;
                const vtodoMatch = icalText.match(/BEGIN:VTODO([\s\S]*?)END:VTODO/);
                if (!vtodoMatch) continue;

                const taskData = this.parseTodoTask(vtodoMatch[1]);
                if (taskData) tasks.push(taskData);
            } catch (error) {
                console.error('Error parsing todo:', error);
            }
        }

        return tasks;
    }

    parseTodoTask(data) {
        const lines = String(data).split('\n');
        let summary = '';
        let dueDate = '';
        let completed = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('SUMMARY:')) {
                summary = trimmed.substring(8);
            } else if (trimmed.startsWith('DUE;')) {
                dueDate = trimmed.substring(trimmed.indexOf(':') + 1);
            } else if (trimmed.includes('STATUS:COMPLETED')) {
                completed = true;
            }
        }

        if (completed || !summary) return null;

        if (dueDate) {
            const date = this.parseAllDayDate(dueDate);
            return `${summary} (${date.toLocaleDateString('ru-RU')})`;
        }

        return summary;
    }

    // ============================================================
    // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // ============================================================

    parseAllDayDate(dateStr) {
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1;
        const day = parseInt(dateStr.substring(6, 8));
        return new Date(Date.UTC(year, month, day));
    }

    parseYandexCalendarDate(dateStr) {
        const [year, month, day, hour, minute, second] = [
            dateStr.substring(0, 4),
            dateStr.substring(4, 6),
            dateStr.substring(6, 8),
            dateStr.substring(9, 11) || '00',
            dateStr.substring(11, 13) || '00',
            dateStr.substring(13, 15) || '00'
        ];

        return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
        );
    }

    getTimeOnly(dateString) {
        if (!dateString) return '';

        const date = new Date(dateString);
        if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
            return '';
        }

        return date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // ============================================================
    // 8. НАСТРОЙКИ И БЕЗОПАСНОСТЬ
    // ============================================================

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    validateSecurityRequirements() {
        if (!this.secureSettings.hasStoredPassword()) {
            new Notice('No password stored. Please save a password first.');
            return false;
        }
        return true;
    }

    async getStoredPassword() {
        return this.secureSettings.hasStoredPassword()
            ? await this.secureSettings.getPassword()
            : null;
    }

    // ============================================================
    // 9. РАБОТА С ЕЖЕДНЕВНЫМИ ЗАМЕТКАМИ
    // ============================================================

    getCurrentDailyNoteDate() {
        const activeFile = this.app.workspace.getActiveFile();
        const dailyNotes = this.getDailyNotesInstance();

        if (!dailyNotes) {
            new Notice('Плагин Daily Notes не найден');
            return null;
        }

        if (!activeFile) {
            new Notice('Нет активной заметки');
            return null;
        }

        const dateFormat = dailyNotes.getFormat();
        const fileName = activeFile.basename;

        if (this.isDailyNote(dateFormat, fileName)) {
            return this.parseDateFromString(dateFormat, fileName);
        }

        new Notice('Это не ежедневная заметка');
        return null;
    }

    isDailyNote(template, str) {
        const regexPattern = this.createDateRegexPattern(template);
        return new RegExp(`^${regexPattern}`).test(str);
    }

    createDateRegexPattern(template) {
        return template
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/YYYY/g, '(\\d{4})')
            .replace(/YY/g, '(\\d{2})')
            .replace(/MM/g, '(\\d{2})')
            .replace(/DD/g, '(\\d{2})');
    }

    parseDateFromString(template, str) {
        const { regexPattern, componentOrder } = this.createRegexWithCaptureGroups(template);
        const regex = new RegExp(`^${regexPattern}`);
        const match = str.match(regex);

        if (!match) {
            throw new Error('Не удалось извлечь дату');
        }

        const components = {};
        for (let i = 0; i < componentOrder.length; i++) {
            components[componentOrder[i]] = parseInt(match[i + 1], 10);
        }

        let year = components.YYYY ? components.YYYY : 2000 + components.YY;
        let month = components.MM - 1;
        let day = components.DD;

        const date = new Date(year, month, day);

        if (isNaN(date.getTime())) {
            throw new Error('Некорректная дата');
        }

        return date;
    }

    createRegexWithCaptureGroups(template) {
        const componentOrder = [];

        const regexPattern = template
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/YYYY/g, () => { componentOrder.push('YYYY'); return '(\\d{4})'; })
            .replace(/YY/g, () => { componentOrder.push('YY'); return '(\\d{2})'; })
            .replace(/MM/g, () => { componentOrder.push('MM'); return '(\\d{2})'; })
            .replace(/DD/g, () => { componentOrder.push('DD'); return '(\\d{2})'; });

        return { regexPattern, componentOrder };
    }

    getDailyNotesInstance() {
        if (this.app.internalPlugins) {
            const plugin = this.app.internalPlugins.getPluginById('daily-notes');
            return plugin?.instance || null;
        }
        return null;
    }

    getDateRange(currentDate) {
        const start = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate(),
            0, 0, 0, 0
        );

        const end = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate() + 1,
            0, 0, 0, 0
        );

        const formatDate = (date) => {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            const hours = String(date.getUTCHours()).padStart(2, '0');
            const minutes = String(date.getUTCMinutes()).padStart(2, '0');
            const seconds = String(date.getUTCSeconds()).padStart(2, '0');

            return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
        };

        return {
            start: formatDate(start),
            end: formatDate(end)
        };
    }

    // ============================================================
    // 10. ФОРМАТИРОВАНИЕ
    // ============================================================

    async formatEventsByPattern(events, pattern) {
        let result = '';
        for (const event of events) {
            if (!event) continue;
            result += event.formatByPatternEvent(pattern) + '\n';
        }
        return await this.unescapeTemplateLiterals(result);
    }

    async unescapeTemplateLiterals(text) {
        return text.replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r');
    }
}

// ============================================================
// 11. DTO КЛАССЫ
// ============================================================

class CalendarEventDto {
    summary = '';
    dateStart = null;
    dateEnd = null;
    timeStart = '';
    timeEnd = '';
    description = '';
    url = '';
    allDay = false;

    constructor(summary, dateStart, dateEnd, timeStart, timeEnd, description, url, allDay = false) {
        this.summary = summary;
        this.dateStart = dateStart;
        this.dateEnd = dateEnd;
        this.timeStart = timeStart;
        this.timeEnd = timeEnd;
        this.description = description;
        this.url = url;
        this.allDay = allDay;
    }

    formatByPatternEvent(pattern) {
        let timeDisplay = '';
        if (this.allDay) {
            timeDisplay = 'Весь день';
        } else if (this.timeStart && this.timeEnd) {
            timeDisplay = `${this.timeStart} - ${this.timeEnd}`;
        } else if (this.timeStart) {
            timeDisplay = this.timeStart;
        }

        const vars = {
            summary: this.summary || '',
            dateStart: this.dateStart ? this.dateStart.toLocaleDateString('ru-RU') : '',
            dateEnd: this.dateEnd ? this.dateEnd.toLocaleDateString('ru-RU') : '',
            timeStart: this.timeStart || '',
            timeEnd: this.timeEnd || '',
            timeDisplay: timeDisplay,
            description: this.description || '',
            url: this.url || ''
        };

        return pattern.replace(/\${(.*?)}/g, (match, key) => {
            return vars.hasOwnProperty(key) && vars[key] !== undefined && vars[key] !== null ? vars[key] : '';
        });
    }
}

// ============================================================
// 12. НАСТРОЙКИ
// ============================================================

class YandexCalendarIntegrationSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        this.renderEmailSetting(containerEl);
        this.renderPasswordInput(containerEl);
        this.renderPatternSetting(containerEl);
    }

    renderEmailSetting(containerEl) {
        new obsidian.Setting(containerEl)
            .setName('Email')
            .setDesc('Введите email для входа в Яндекс Календарь')
            .addText((text) => text
                .setPlaceholder('Enter your email')
                .setValue(this.plugin.settings.email)
                .onChange(async (value) => {
                    this.plugin.settings.email = value;
                    await this.plugin.saveSettings();
                })
            );
    }

    renderPasswordInput(containerEl) {
        const linkContainer = containerEl.createDiv();
        linkContainer.appendText('Введите пароль приложения для Яндекс Календаря ');

        const linkElement = document.createElement('a');
        linkElement.href = 'https://id.yandex.ru/security/app-passwords';
        linkElement.textContent = 'Создать пароль приложения';
        linkContainer.appendChild(linkElement);

        let password = '';

        new obsidian.Setting(containerEl)
            .setName('Password')
            .setDesc(linkContainer)
            .addText(text => text
                .setPlaceholder('Enter password')
                .setValue('')
                .onChange((value) => password = value)
            )
            .addButton(button => button
                .setButtonText('Сохранить пароль')
                .setCta()
                .onClick(async () => {
                    if (!password) {
                        new Notice('Пожалуйста, введите пароль');
                        return;
                    }
                    await this.plugin.secureSettings.savePassword(password);
                    new Notice('Пароль сохранен!');
                    this.display();
                })
            )
            .addButton(button => button
                .setButtonText('Очистить пароль')
                .onClick(async () => {
                    this.plugin.secureSettings.clearPassword();
                    new Notice('Пароль очищен');
                    this.display();
                })
            );
    }

    renderPatternSetting(containerEl) {
        new obsidian.Setting(containerEl)
            .setName('Шаблон встречи')
            .setDesc('Настройте формат вывода встречи')
            .addText((text) => text
                .setPlaceholder('Enter pattern')
                .setValue(this.plugin.settings.pattern)
                .onChange(async (value) => {
                    this.plugin.settings.pattern = value;
                    await this.plugin.saveSettings();
                })
            );
    }
}

// ============================================================
// 13. НАСТРОЙКИ ПО УМОЛЧАНИЮ
// ============================================================

const DEFAULT_SETTINGS = {
    pattern: "- [ ] ${timeDisplay}: ${summary}\n\tОписание: ${description}\n\tСсылка на событие: ${url}",
    email: ''
}

// ============================================================
// 14. БЕЗОПАСНОЕ ХРАНЕНИЕ
// ============================================================

class SecureSettings {
    constructor(plugin) {
        this.plugin = plugin;
        this.serviceId = `yandex-calendar-${plugin.manifest.id}`;
    }

    async savePassword(password) {
        try {
            if (this.plugin.app.saveLocalStorage) {
                await this.plugin.app.saveLocalStorage(this.serviceId, password);
                return true;
            }
        } catch (error) {
            console.error('Failed to save password:', error);
        }
        return false;
    }

    async getPassword() {
        try {
            if (this.plugin.app.loadLocalStorage) {
                return await this.plugin.app.loadLocalStorage(this.serviceId);
            }
        } catch (error) {
            console.error('Failed to load password:', error);
        }
        return null;
    }

    async hasStoredPassword() {
        return this.getPassword().then(pwd => pwd !== null);
    }

    async clearPassword() {
        try {
            if (this.plugin.app.saveLocalStorage) {
                await this.plugin.app.saveLocalStorage(this.serviceId, null);
                console.log('Cleared password via saveLocalStorage(null)');
            }
        } catch (error) {
            console.error('Failed to clear password:', error);
        }
    }
}

// ============================================================
// 15. ЭКСПОРТ
// ============================================================

module.exports = YandexCalendarIntegrationPlugin;
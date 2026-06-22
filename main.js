'use strict';

var obsidian = require('obsidian');

class YandexCalendarIntegrationPlugin extends obsidian.Plugin {
    settings = null;
    secureSettings = null;

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

    registerCommands() {
        // Основная команда - вставка событий
        this.addCommand({
            id: 'insert-event-from-yandex-calendar-at-cursor',
            name: 'Вставить событие из Яндекс Календаря в позицию курсора',
            editorCallback: (editor) => {
                this.insertEvent(editor);
            }
        });

        // ТЕСТОВАЯ КОМАНДА - поиск коллекции задач
        this.addCommand({
            id: 'test-find-todo-collection',
            name: 'Тест: найти коллекцию задач',
            callback: () => {
                this.testFindTodo();
            }
        });
    }

    async makeRequest(email, password, baseUrl, uri, body) {
        try {
            const token = btoa(`${email}:${password}`);
            const url = baseUrl + uri;

            const response = await requestUrl({
                url: url,
                method: 'REPORT',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml',
                    'Depth': '1'
                },
                body: body
            });

            new Notice('Яндекс Календарь успешно вернул события');
            return response.text;
        } catch (error) {
            console.error('Запрос к Яндекс Календарю завершился ошибкой: ', error);
            new Notice('Запрос к Яндекс Календарю завершился ошибкой: ' + error.message);
            throw error;
        }
    }

    parseCalendarEvents(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const responses = xmlDoc.getElementsByTagNameNS('DAV:', 'response');
        
        return Array.from(responses).map(response => {
            try {
                const calendarData = response.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-data')[0];
                if (!calendarData) return null;

                const icalText = calendarData.textContent;
                
                // Парсим только VEVENT (события)
                const veventMatch = icalText.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);
                return veventMatch ? this.parseYandexCalendar(veventMatch[1]) : null;
            } catch (error) {
                console.error('Error parsing event:', error);
                return null;
            }
        }).filter(event => event !== null);
    }

    parseYandexCalendar(data) {
        const lines = String(data).split('\n');
        const eventData = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('SUMMARY:')) {
                eventData.summary = line.substring(8);
            } else if (line.startsWith('DTSTART;TZID=')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateStart = this.parseYandexCalendarDate(dateStr);
                eventData.allDay = false;
            } else if (line.startsWith('DTSTART;VALUE=DATE:')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateStart = this.parseAllDayDate(dateStr);
                eventData.allDay = true;
            } else if (line.startsWith('DTSTART:')) {
                const dateStr = line.substring(8);
                if (dateStr.length === 8) {
                    eventData.dateStart = this.parseAllDayDate(dateStr);
                    eventData.allDay = true;
                } else {
                    eventData.dateStart = this.parseYandexCalendarDate(dateStr);
                    eventData.allDay = false;
                }
            } else if (line.startsWith('DTEND;TZID=')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateEnd = this.parseYandexCalendarDate(dateStr);
            } else if (line.startsWith('DTEND;VALUE=DATE:')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateEnd = this.parseAllDayDate(dateStr);
            } else if (line.startsWith('DTEND:')) {
                const dateStr = line.substring(6);
                if (dateStr.length === 8) {
                    eventData.dateEnd = this.parseAllDayDate(dateStr);
                } else {
                    eventData.dateEnd = this.parseYandexCalendarDate(dateStr);
                }
            } else if (line.startsWith('DESCRIPTION:')) {
                eventData.description = line.substring(12);
            } else if (line.startsWith('URL:')) {
                eventData.url = line.substring(4);
            }
        }

        const timeStart = eventData.allDay ? '' : this.getTimeOnly(eventData.dateStart);
        const timeEnd = eventData.allDay ? '' : this.getTimeOnly(eventData.dateEnd);

        return new CalendarEventDto(
            eventData.summary,
            eventData.dateStart,
            eventData.dateEnd,
            timeStart,
            timeEnd,
            eventData.description,
            eventData.url,
            eventData.allDay || false
        );
    }

    parseAllDayDate(dateStr) {
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1;
        const day = parseInt(dateStr.substring(6, 8));
        return new Date(Date.UTC(year, month, day));
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

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    }

    async saveSettings() {
        await this.saveData(this.settings)
    }

    async insertEvent(editor) {
        try {
            if (!this.validateSecurityRequirements()) {
                return;
            }

            const events = await this.getEvents();
            const pattern = this.settings.pattern;

            const sortedEvents = events.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
            const formattedEvents = await this.formatEventsByPattern(sortedEvents, pattern);
           
            const cursor = editor.getCursor();
            editor.replaceRange(formattedEvents, cursor);
        } catch (error) {
            console.error('Failed to insert event:', error);
            new Notice('Failed to insert event from Yandex Calendar');
        }
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

    async testFindTodo() {
        new Notice('🔍 Ищем коллекцию задач...');
        const todoUrl = await this.findTodoCollection();
        if (todoUrl) {
            new Notice(`✅ Коллекция найдена: ${todoUrl}`);
            const tasks = await this.getTasksFromCollection(todoUrl);
            if (tasks) {
                new Notice('✅ Задачи получены. Смотрите консоль (F12)');
            } else {
                new Notice('❌ Не удалось получить задачи');
            }
        } else {
            new Notice('❌ Коллекция не найдена. Создайте задачу в календаре.');
        }
    }

    async getEvents() {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();

            if (!email || !password) {
                new Notice('Email or password not configured');
                throw new Error('Email or password not configured');
            }

            const baseUrl = 'https://caldav.yandex.ru';
            const uri = `/calendars/${email}/events-default`;
            const currentDate = this.getCurrentDailyNoteDate();

            if (!currentDate) {
                return [];
            }

            const { start, end } = this.getDateRange(currentDate);
            const body = this.buildCalendarQuery(start, end);

            const data = await this.makeRequest(email, password, baseUrl, uri, body);
            const events = this.parseCalendarEvents(data);
            console.log('Parsed events: ', events);
            return events;
        } catch (error) {
            console.error('Failed to get events:', error);
            return [];
        }
    }

    async findTodoCollection() {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();

            if (!email || !password) {
                new Notice('Email or password not configured');
                return null;
            }

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

            console.log('=== СПИСОК ВСЕХ КОЛЛЕКЦИЙ ===');
            console.log(response.text);
            
            // Парсим ответ, чтобы найти коллекцию задач
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(response.text, 'text/xml');
            
            // Ищем все href
            const hrefs = xmlDoc.getElementsByTagNameNS('DAV:', 'href');
            const collections = [];
            
            for (let i = 0; i < hrefs.length; i++) {
                const href = hrefs[i].textContent;
                // Ищем href, который содержит todos или tasks
                if (href && (href.includes('todos') || href.includes('tasks'))) {
                    collections.push(href);
                    console.log(`Найдена коллекция задач: ${href}`);
                }
            }
            
            if (collections.length > 0) {
                // Берем первую найденную коллекцию
                const todoUrl = collections[0].startsWith('http') 
                    ? collections[0] 
                    : `https://caldav.yandex.ru${collections[0]}`;
                console.log(`Используем URL для задач: ${todoUrl}`);
                new Notice(`Найдена коллекция задач: ${todoUrl}`);
                return todoUrl;
            } else {
                console.log('Коллекция задач не найдена');
                new Notice('Коллекция задач не найдена. Попробуйте создать задачу в календаре.');
                return null;
            }
        } catch (error) {
            console.error('Ошибка поиска коллекции задач:', error);
            new Notice('Ошибка поиска коллекции задач: ' + error.message);
            return null;
        }
    }



    async getTasksFromCollection(todoUrl) {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();

            if (!email || !password) {
                return [];
            }

            const token = btoa(`${email}:${password}`);
            
            // Запрос на получение всех задач из коллекции
            const xmlQuery = `<?xml version="1.0" encoding="utf-8" ?>
    <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <c:calendar-data>
                <c:comp name="VCALENDAR">
                    <c:comp name="VTODO">
                        <c:prop name="SUMMARY"/>
                        <c:prop name="DTSTART"/>
                        <c:prop name="DUE"/>
                        <c:prop name="DESCRIPTION"/>
                        <c:prop name="URL"/>
                        <c:prop name="PRIORITY"/>
                        <c:prop name="STATUS"/>
                        <c:prop name="COMPLETED"/>
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

            const response = await requestUrl({
                url: todoUrl,
                method: 'REPORT',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Depth': '1'
                },
                body: xmlQuery
            });

            console.log('=== ЗАДАЧИ ИЗ КОЛЛЕКЦИИ ===');
            console.log(response.text);
            
            return response.text;
        } catch (error) {
            console.error('Ошибка получения задач:', error);
            return null;
        }
    }

    buildCalendarQuery(start, end) {
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
            const noteDate = this.parseDateFromString(dateFormat, fileName);
            new Notice(`Дата заметки: ${noteDate.toLocaleDateString('ru-RU')}`);
            return noteDate;
        } else {
            new Notice('Это не ежедневная заметка');
            return null;
        }
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

        let year, month, day;

        if (components.YYYY) {
            year = components.YYYY;
        } else if (components.YY) {
            year = 2000 + components.YY;
        } else {
            throw new Error('Не найден год в шаблоне');
        }

        if (components.MM) {
            month = components.MM - 1;
        } else {
            throw new Error('Не найден месяц в шаблоне');
        }

        if (components.DD) {
            day = components.DD;
        } else {
            throw new Error('Не найден день в шаблоне');
        }

        const date = new Date(year, month, day);

        if (isNaN(date.getTime())) {
            throw new Error('Некорректная дата');
        }

        if (date.getFullYear() !== year ||
            date.getMonth() !== month ||
            date.getDate() !== day) {
            throw new Error('Некорректная дата');
        }

        return date;
    }

    createRegexWithCaptureGroups(template) {
        const componentOrder = [];

        const regexPattern = template
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/YYYY/g, () => {
                componentOrder.push('YYYY');
                return '(\\d{4})';
            })
            .replace(/YY/g, () => {
                componentOrder.push('YY');
                return '(\\d{2})';
            })
            .replace(/MM/g, () => {
                componentOrder.push('MM');
                return '(\\d{2})';
            })
            .replace(/DD/g, () => {
                componentOrder.push('DD');
                return '(\\d{2})';
            });

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

    async formatEventsByPattern(events, pattern) {
        let patternFormattedEvents = '';
        for (let event of events) {
            let formatText = event.formatByPatternEvent(pattern);
            patternFormattedEvents = patternFormattedEvents + formatText + '\n';
        }
        return await this.unescapeTemplateLiterals(patternFormattedEvents);
    }

    async unescapeTemplateLiterals(text) {
        return text.replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r');
    }
}

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
            .setDesc('Enter the email address that is used for scheduling in the calendar')
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
        linkContainer.appendText("Enter your Yandex Calendar ");
        
        const linkElement = document.createElement('a');
        linkElement.href = 'https://id.yandex.ru/security/app-passwords';
        linkElement.textContent = 'app password';
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
                .setButtonText('Save Password')
                .setCta()
                .onClick(async () => {
                    if (!password) {
                        new Notice('Please enter a password');
                        return;
                    }

                    await this.plugin.secureSettings.savePassword(password);
                    new Notice('Password saved securely!');
                    this.display();
                })
            ).addButton(button => button
                .setButtonText('Clear Password')
                .onClick(async () => {
                    this.plugin.secureSettings.clearPassword();
                    new Notice('Password cleared');
                    this.display();
                })
            );
    }

    renderPatternSetting(containerEl) {
        new obsidian.Setting(containerEl)
            .setName('Event task pattern')
            .setDesc('Enter a pattern for the event task')
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

const DEFAULT_SETTINGS = {
    pattern: "- [ ] ${timeDisplay}: ${summary}\n\tОписание: ${description}\n\tСсылка на событие: ${url}",
    email: ''
}

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

module.exports = YandexCalendarIntegrationPlugin;
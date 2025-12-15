export class AskComponent {
    constructor(apiUrl) {
        this.apiUrl = apiUrl;
        this.container = null;
        this.isExpanded = false;
        this.init();
    }

    init() {
        this.container = document.getElementById("ask-container");
        if (!this.container) return;

        this.render();
        this.setupEventListeners();
    }

    render() {
        this.container.innerHTML = `
            <div class="ask-section">
                <button class="ask-toggle" aria-expanded="false" type="button">
                    <span class="ask-toggle-icon">?</span>
                    <span class="ask-toggle-text">Ask a question about the weather</span>
                    <span class="ask-toggle-arrow">▼</span>
                </button>
                <div class="ask-panel" hidden>
                    <form class="ask-form">
                        <div class="ask-input-wrapper">
                            <div class="ask-input-container">
                                <input
                                    type="text"
                                    class="ask-input"
                                    placeholder="e.g., When was the last dry day?"
                                    maxlength="500"
                                    aria-label="Weather question"
                                    autocomplete="off"
                                />
                                <button type="button" class="ask-clear" aria-label="Clear question" hidden>
                                    ✕
                                </button>
                            </div>
                            <button type="submit" class="ask-submit" aria-label="Submit question">
                                Ask
                            </button>
                        </div>
                        <div class="ask-hints">
                            Try: "What's the weather tomorrow?" or "When did it last rain?"
                        </div>
                    </form>
                    <div class="ask-result" hidden>
                        <div class="ask-answer"></div>
                        <div class="ask-citations"></div>
                    </div>
                    <div class="ask-loading" hidden>
                        <div class="ask-spinner"></div>
                        <span>Thinking...</span>
                    </div>
                    <div class="ask-error" hidden></div>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        const toggle = this.container.querySelector(".ask-toggle");
        const panel = this.container.querySelector(".ask-panel");
        const form = this.container.querySelector(".ask-form");
        const input = this.container.querySelector(".ask-input");
        const clearBtn = this.container.querySelector(".ask-clear");

        toggle.addEventListener("click", () => {
            this.isExpanded = !this.isExpanded;
            toggle.setAttribute("aria-expanded", this.isExpanded);
            panel.hidden = !this.isExpanded;
            toggle.querySelector(".ask-toggle-arrow").textContent = this.isExpanded ? "▲" : "▼";

            if (this.isExpanded) {
                input.focus();
            }
        });

        form.addEventListener("submit", (e) => this.handleSubmit(e));

        // Allow Enter key to submit
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                form.dispatchEvent(new Event("submit"));
            }
        });

        // Show/hide clear button based on input content
        input.addEventListener("input", () => {
            clearBtn.hidden = input.value.length === 0;
        });

        // Clear button click handler
        clearBtn.addEventListener("click", () => {
            input.value = "";
            clearBtn.hidden = true;
            input.focus();
        });
    }

    async handleSubmit(e) {
        e.preventDefault();

        const input = this.container.querySelector(".ask-input");
        const question = input.value.trim();

        if (!question) {
            this.showError("Please enter a question.");
            return;
        }

        if (question.length < 3) {
            this.showError("Question is too short.");
            return;
        }

        this.showLoading();
        this.hideError();
        this.hideResult();

        try {
            const response = await fetch(`${this.apiUrl}/ask`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question }),
            });

            const data = await response.json();

            if (data.success) {
                this.showResult(data);
            } else {
                let errorMessage = data.message || "Something went wrong. Please try again.";

                // Handle specific error types
                if (data.error === "service_busy") {
                    errorMessage = "The service is temporarily busy. Please try again later.";
                } else if (data.error === "unanswerable") {
                    errorMessage = data.message;
                }

                this.showError(errorMessage);
            }
        } catch (error) {
            console.error("Ask error:", error);
            this.showError("Failed to connect. Please check your connection and try again.");
        } finally {
            this.hideLoading();
        }
    }

    showResult(data) {
        const resultDiv = this.container.querySelector(".ask-result");
        const answerDiv = this.container.querySelector(".ask-answer");
        const citationsDiv = this.container.querySelector(".ask-citations");

        answerDiv.textContent = data.answer;

        if (data.citations && data.citations.length > 0) {
            citationsDiv.innerHTML = `
                <div class="citations-label">Based on forecast data:</div>
                ${data.citations
                    .map(
                        (c) => `
                    <div class="citation">
                        <a href="#" class="citation-date" data-date="${c.forecast_date}">${this.formatDate(c.forecast_date)}</a>
                        ${c.description ? `<span class="citation-desc"> - ${c.description}</span>` : ""}
                    </div>
                `
                    )
                    .join("")}
            `;

            // Add click handlers to citation links
            citationsDiv.querySelectorAll(".citation-date").forEach((link) => {
                link.addEventListener("click", (e) => {
                    e.preventDefault();
                    const date = link.dataset.date;
                    this.navigateToDate(date);
                });
            });

            citationsDiv.hidden = false;
        } else {
            citationsDiv.hidden = true;
        }

        resultDiv.hidden = false;
    }

    navigateToDate(dateStr) {
        const dateFilter = document.getElementById("forecast-date");
        if (dateFilter) {
            dateFilter.value = dateStr;
            dateFilter.dispatchEvent(new Event("change"));

            // Scroll to the forecast section
            const forecastContainer = document.getElementById("forecast-container");
            if (forecastContainer) {
                forecastContainer.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        }
    }

    hideResult() {
        this.container.querySelector(".ask-result").hidden = true;
    }

    showLoading() {
        this.container.querySelector(".ask-loading").hidden = false;
        this.container.querySelector(".ask-submit").disabled = true;
        this.container.querySelector(".ask-input").disabled = true;
    }

    hideLoading() {
        this.container.querySelector(".ask-loading").hidden = true;
        this.container.querySelector(".ask-submit").disabled = false;
        this.container.querySelector(".ask-input").disabled = false;
    }

    showError(message) {
        const errorDiv = this.container.querySelector(".ask-error");
        errorDiv.textContent = message;
        errorDiv.hidden = false;
    }

    hideError() {
        this.container.querySelector(".ask-error").hidden = true;
    }

    formatDate(dateStr) {
        const date = new Date(dateStr + "T12:00:00Z");
        return date.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }
}

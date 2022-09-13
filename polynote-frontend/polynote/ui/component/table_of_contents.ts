import {div, h2, TagElement} from "../tags";
import {ServerStateHandler} from "../../state/server_state";
import {Disposable, IDisposable, UpdateResult} from "../../state";
import {CellState, NotebookStateHandler} from "../../state/notebook_state";

export interface TOCState {
    title: string,
    cellId: number,
    heading: string,
    active: boolean
}

/**
 * Manages and renders the table of contents for the current notebook.
 *
 * This should be expanded on in the future by being "plugged in" to the notebook state, so it isn't just listening to the current notebook.
 * It would be better if this was listening to every open notebook and changing the local state, so a complete re-calculation
 * doesn't have to occur on every notebook change.
 *
 * It would also be prudent to not have to do re-render the entire TOC whenever a single text cell changes
 * We only update the state of the cell that changes state, but we still re-render the entire TOC today for simplicity
 * (because of cases like insertion in the middle of a list and changing cell order makes DOM manipulation non-trivial)
 */
export class TableOfContents extends Disposable {
    readonly el: TagElement<"div">;
    readonly header: TagElement<"h2">;

    private notebookState: NotebookStateHandler;
    private observers: IDisposable[];

    private curNBTOC: Record<number, TOCState[]> | undefined;
    private cellOrder: number[];

    constructor() {
        super();

        this.onDispose.then(() => {
            this.observers.forEach(obs => obs.dispose());
        });

        this.observers = [];
        this.cellOrder = [];

        this.header = h2([], ["Table of Contents"]);
        this.el = div(["table-of-contents"], []);

        ServerStateHandler.get.view("currentNotebook").addObserver((newPath, update) => {
            this.curNBTOC = undefined;
            this.cellOrder = [];

            if (newPath !== undefined && update.newValue !== "home") {
                const nb = ServerStateHandler.getOrCreateNotebook(newPath);
                if (nb?.handler) {
                    // If there was previously a notebook, the observers already exist, so discard them and re-calculate everything
                    if (this.observers.length !== 0) {
                        this.observers.forEach(obs => obs.dispose());
                        this.observers = [];
                    }

                    this.notebookState = nb.handler;
                    this.initTOCObservers();
                } else { // some error happened loading the notebook, so display an error message
                    this.generateTOCHTML(true);
                }
            } else { // if not a valid nb, then change the HTML to reflect that
                this.generateTOCHTML();
            }
        }).disposeWith(this)
    }

    /**
     * Initializes all the observers necessary for the TOC, and calls the ones necessary to initialize a new notebook
     */
    private initTOCObservers() {
        this.observers.push(this.notebookState.view("activeCellId").addObserver(activeCellId => {
            this.findAndSelectNearestHeader(activeCellId);
        }));

        this.observers.push(this.notebookState.view("cellOrder").addObserver((newOrder) => this.changeCellOrder(newOrder)));
        this.changeCellOrder(this.notebookState.state.cellOrder);

        this.observers.push(this.notebookState.view("cells").addObserver((newCells, update) => this.changeCells(newCells, update)));
        this.changeCells(this.notebookState.state.cells);
    }

    /**
     * Handles a new notebook cell order and then re-renders the TOC HTML accordingly
     */
    private changeCellOrder(newOrder: number[]) {
        let order = [];

        for (const location of Object.values(newOrder)) {
            order.push(location);
        }

        this.cellOrder = order;
        this.generateTOCHTML();
    }

    /**
     * Handles a change in a cell(s)' state by finding all updated cells and then re-renders the TOC HTML accordingly
     */
    private changeCells(newCells: Record<number, CellState>, update?: UpdateResult<Record<number, CellState>>) {
        let newTOC: Record<number, TOCState[]> = [];
        let cellsToUpdate: Record<number, CellState> = {};

        // Gather a list of all text cells that must be updated
        if (this.curNBTOC === undefined) // If the TOC has not been initialized for this notebook yet, use all cells
            cellsToUpdate = newCells;
        else if (update?.fieldUpdates) {
            for (const [id, fieldUpdate] of Object.entries(update.fieldUpdates)) {
                if (fieldUpdate?.fieldUpdates?.content && fieldUpdate.newValue?.language === "text") {
                    cellsToUpdate[parseInt(id)] = this.notebookState.state.cells[parseInt(id)];
                }
            }
        }

        // If there were any text cells with new content, update them in the TOC
        if (Object.keys(cellsToUpdate).length > 0) {
            newTOC = this.updateTOC(cellsToUpdate);
            this.curNBTOC = newTOC;
            this.generateTOCHTML();
        }
    }

    /**
     * Updates the current TOC data structure by finding all headings in the current cell and inserting them into a resulting dict
     */
    private updateTOC(cells: Record<number, CellState>): Record<number, TOCState[]> {
        let newTOC: Record<number, TOCState[]> = this.curNBTOC !== undefined ? this.curNBTOC : {};

        for (const [id, state] of Object.entries(cells)) {
            if (state.language === "text") {
                const headings = this.extractHeadingsFromCell(state.content, state.id);

                // If this heading was previously active and has been updated, make sure to mark it as active
                if (newTOC[parseInt(id)] !== undefined && newTOC[parseInt(id)][0].active) {
                    headings[0].active = true;
                }

                newTOC[parseInt(id)] = headings;
            }
        }

        return newTOC;
    }

    /**
     * Converts each line that is a heading into a new element in the table of contents dict
     */
    private extractHeadingsFromCell(content: string, cellId: number): TOCState[] {
        let results: TOCState[] = [];
        const headings = content.match(/#{1,6}.+/g); // Extracts h1-h6 tags denoted with '#' at the start of each line

        headings?.forEach(function (s, index) {
            const heading = s.trim().substring(0, s.indexOf(' '));
            const title = s.trim().substring(s.indexOf(' ') + 1);

            if (heading !== null && title !== null) {
                results.push({
                    title,
                    cellId,
                    heading: "h" + heading.length,
                    active: false
                })
            }
        })

        return results;
    }

    /**
     * Converts the current notebook's table of contents into HTML and renders it
     * @param error denotes whether or not the table of contents is currently in an error state and should display as such
     */
    private generateTOCHTML(error: boolean = false): void {
        this.el.innerHTML = "";
        if (error) {
            this.el.appendChild(h2([], ["There was an error loading your table of contents. Please refresh the page."]));
        } else {
            if (this.curNBTOC !== undefined && Object.keys(this.curNBTOC).length > 0 && this.cellOrder.length > 0) {
                this.cellOrder.forEach(num => {
                    if (this.curNBTOC !== undefined && this.curNBTOC[num] !== undefined && this.notebookState.state.cells[num].language === "text") {
                        for (const tocEl of Object.values(this.curNBTOC[num])) {
                            this.el.appendChild(this.tocElToTag(tocEl));
                        }
                    }
                });
            } else {
                this.el.appendChild(h2([], ["No table of contents yet. To get started, make an h1-h6 heading."]));
            }
        }
    }

    /**
     * Converts a given table of contents element into the proper HTML semantic tag
     */
    private tocElToTag(tocEl: TOCState): HTMLHeadingElement {
        let h = h2([tocEl.heading], tocEl.title).dataAttr('data-cellid', tocEl.cellId.toString());
        if (tocEl.active)
            h.classList.add('active');
        this.onHeadingClick(tocEl.cellId, h);
        return h;
    }

    /**
     * Attaches a click handler to a given TOC heading element. This action will:
     *   - Jump to the respective cell ID the heading represents
     *   - Attach a UI visual that that heading is currently selected
     *   - Mark the previously active heading (if applicable) as not active
     */
    private onHeadingClick(cellId: number, el: TagElement<any>) {
        el.click(() => {
            if (cellId !== this.notebookState.state.activeCellId) {
                this.notebookState.selectCell(cellId, {editing: true});
                this.markCellAsActive(cellId);
            } else {
                const oldActiveEl = this.el.querySelector('.active');
                oldActiveEl?.classList.remove('active');
                const oldCellId = oldActiveEl?.getAttribute('data-cellid');

                el.classList.add('active');
                this.markCellAsActive(cellId, oldCellId);
            }
        })
    }

    /**
     * Selects a header by its cell ID (this should only be used for when a cell has been clicked on and a heading needs to be focused)
     */
    private selectHeaderFromCell(cellId?: number) {
        const oldActiveEl = this.el.querySelector('.active');
        oldActiveEl?.classList.remove('active');
        const oldCellId = oldActiveEl?.getAttribute('data-cellid');

        if (cellId !== undefined) {
            const newActiveEl = document.body.querySelector(`[data-cellid="${cellId}"]`);
            newActiveEl?.classList.add('active');
            this.markCellAsActive(cellId, oldCellId);
        }
    }

    /**
     * Finds the nearest cell with a header element to the current cell and selects it as focused in the UI if possible
     */
    private findAndSelectNearestHeader(activeCellId: number | undefined) {
        if (this.curNBTOC === undefined) return;

        if (activeCellId === undefined || Object.keys(this.curNBTOC).length === 0) {
            const oldActiveEl = this.el.querySelector('.active');
            oldActiveEl?.classList.remove('active');
            return;
        }

        let i = this.cellOrder.indexOf(activeCellId);
        if (this.curNBTOC[activeCellId] === undefined || this.curNBTOC[activeCellId].length === 0) {
            i--;
            while (i >= 0 && (this.curNBTOC[this.cellOrder[i]] === undefined || this.curNBTOC[this.cellOrder[i]].length === 0)) {
                i--;
            }
        }

        // Select the above markdown cell if it was found, otherwise select nothing and deselect the current selection
        this.selectHeaderFromCell(i !== -1 ? this.cellOrder[i] : undefined);
    }

    /**
     * Helper function for marking a cell as active in the current notebook's TOC that deals with different types of oldCellIds
     */
    private markCellAsActive(newCellId: number, oldCellId?: string | null): void {
        if (this.curNBTOC !== undefined) {
            if (oldCellId !== undefined && oldCellId !== null) {
                this.curNBTOC[parseInt(oldCellId)][0].active = false;
            }
            this.curNBTOC[newCellId][0].active = true;
        }
    }
}
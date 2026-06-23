# tasks-and-topics

A note taking "app"

---

Lightweight notes workspace using a tasks + topics structure, with a small CLI: `tt`.

> `tt` stands for "tasks and topics". It provides a simple interface for managing notes organized by topics, along with an active task list.

## tt

### User-local install

Run from your folder where `tt` is located:

```bash
chmod +x tt
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/tt" "$HOME/.local/bin/tt"
```

### Usage

Go to your notes folder and run `tt init` to create the necessary structure. Then you can add tasks and topics, list them, mark tasks as done, and archive topics.

> Your notes folder should be a git repository so you can track changes and history. `tt apply` will commit changes to the repo.

### Commands

```bash
tt init
tt add task "do the job"
tt add task -p high "urgent thing"
tt add topic "job stuffs"
tt ls tasks
tt ls topics
tt done 2
tt archive topic 2026-06-22-job-stuffs
tt help
```

### What each command does

- `tt init`: creates/ensures `tasks/`, `topics/template/`, `archive/`, and base files.
- `tt add task ...`: adds a checklist item to `tasks/active.md`.
- `tt add topic ...`: creates `topics/YYYY-MM-DD-topic-name/index.md` from template.
- `tt ls tasks`: lists open tasks as numbered items.
- `tt ls topics`: lists current topic folders (excluding `template`).
- `tt done N`: marks the Nth open task as done.
- `tt archive topic NAME`: moves a topic from `topics/` to `archive/`.

## Example structure

In `example-notebook/` you can find the result of following commands. Try it yourself to see how it works!

```bash
mkdir example-notebook
cd example-notebook
tt init
```

Now you can add tasks and topics:



```bash
tt "do the job"  # Adds a new task. Press enter to select no related topic
```

```bash
tt add task -p high "urgent thing"  # Same as above, but with a high priority. Press enter to select no related topic
```

```bash
tt add topic "job stuffs"  # Creates new topic folder `topics/YYYY-MM-DD-job-stuffs/` with an `index.md` file from template.
```

```bash
tt add task "this is related to the **job topic**"  # now select 1) to connect task to topic
```

```bash
tt  # lists active tasks
```

Output:

```
1. [High] urgent thing
2. [Medium] this is related to the **job topic** - [Related: 2026-06-23-job-stuffs](../topics/2026-06-23-job-stuffs/index.md)
3. [Medium] do the job
```
